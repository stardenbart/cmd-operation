# PRD — Migrasi FM Receiving App: Power Apps Canvas → Web App (React + Node.js + MySQL)

| | |
|---|---|
| **Produk** | FM Receiving — Sistem Penerimaan, Prepasteurisasi, Transfer & Monitoring Fresh Milk |
| **Sumber** | Power Apps Canvas App `831f41c0-7661-426e-9f3e-1738f97646b9` (env `Default-ca373342-...`) |
| **Target stack** | React 18 (Vite) · Node.js/Express (JavaScript) · MySQL 8 |
| **Penyusun** | Abdullah Farauk |
| **Tanggal** | 25 Agustus 2026 |
| **Status** | v2 — siap eksekusi · 15 keputusan tertutup, 0 terbuka |

---

## 1. Executive Summary

FM Receiving adalah aplikasi operasional pabrik yang melacak perjalanan susu segar dari penerimaan truk supplier sampai dipakai produksi, lengkap dengan alokasi FIFO per supplier, standing time per silo, jejak approval berjenjang, dan koreksi data yang bisa di-rollback.

Aplikasi eksisting dibangun sebagai Power Apps Canvas App bertumpu pada 9 SharePoint List. Analisa terhadap 14 screen dan ±12.500 baris YAML menunjukkan aplikasi ini sudah **melampaui batas wajar platform low-code**: seluruh logika transaksional (alokasi FIFO, reversal, cascade void) ditulis sebagai formula Power Fx di dalam `OnSelect` tombol, tanpa transaksi database, tanpa constraint referensial, dan tanpa perlindungan terhadap race condition.

Migrasi ini bertujuan memindahkan aplikasi ke stack web standar dengan tiga sasaran utama:

1. **Memindahkan business logic ke server** — alokasi FIFO dan rollback jadi transaksi ACID, bukan rangkaian `Patch()` yang bisa gagal separuh jalan.
2. **Menghapus batas delegasi SharePoint** — query agregat saat ini rawan salah hitung begitu tabel melewati 2.000 baris.
3. **Memperbaiki model data** — datetime sebagai string, ID acak, dan volume yang tak pernah dipersist adalah sumber utama bug operasional saat ini.

Fungsionalitas bisnis dipertahankan 1:1. Yang berubah adalah fondasinya.

---

## 2. Analisa Kondisi Saat Ini (As-Is)

### 2.1 Inventaris Screen

| # | Screen | Peran | Ukuran (baris YAML) |
|---|---|---|---|
| 1 | `Scr_Login` | Login operator via dropdown nama + PIN 4 digit | 264 |
| 2 | `Scr_Home` | Dashboard overview semua silo + navigasi modul | 1.101 |
| 3 | `Scr_QRScan_Silo` | Scan QR / pilih silo, lalu routing ke modul aktif | 417 |
| 4 | `Scr_QRScan_Tank` | Scan QR tank tujuan (jalur transfer produksi) | 275 |
| 5 | `Scr_Receiving_Input` | Input penerimaan susu dari supplier ke buffer | 764 |
| 6 | `Scr_Prepast_Input` | Input prepasteurisasi buffer → silo penyimpanan | 1.135 |
| 7 | `Scr_Transfer_Input` | Transfer keluar silo (produksi / pindah silo) + FIFO | 1.296 |
| 8 | `Scr_Monitoring_Input` | Input cek pH & suhu per silo | 571 |
| 9 | `Scr_SO_Input` | Stock opname bulanan per silo | 500 |
| 10 | `Scr_Approval` | Antrean approval SPV (4 tab) + edit request | 2.205 |
| 11 | `Scr_DataList` | Daftar semua record + edit / void / request edit | 2.194 |
| 12 | `Scr_Detail` | Detail per silo: riwayat prepast, monitoring, transfer | 1.361 |
| 13 | `Scr_Export` | Generate rekap Excel via Power Automate | 362 |
| 14 | `App` (OnStart) | Bootstrap collection master & variabel global | 40 |

### 2.2 Data Source

Seluruhnya SharePoint List di tenant yang sama:

| List | Fungsi | Kolom bisnis |
|---|---|---|
| `FM_Receiving_Penerimaan` | Header penerimaan dari supplier | 28 |
| `FM_Prepast_Record` | Batch hasil prepasteurisasi di silo | 32 |
| `FM_Receiving_Transfer` | Transfer keluar silo | 30 |
| `FM_Receiving_Monitoring` | Cek pH/suhu berkala | 21 |
| `FM_Stock_Opname` | Snapshot stok awal periode | 12 |
| `FM_Batch_Traceability` | Penelusuran batch produk jadi | 19 |
| `Silo_Master` | Master silo + `StandingTimeAnchor` | 18 |
| `Supplier_Master` | Master supplier | 10 |
| `Operator_Master` | User + PIN + role | 13 |

Plus satu konektor Power Automate: **`ExportRekapFM.Run(startDate, endDate, email)`** yang menghasilkan file Excel ke SharePoint dan mengirim notifikasi email.

`colTankMaster` (10 tank: MT 1–5, MT 10–12, CMD 2, PENGOSONGAN SILO) **di-hardcode di `App.OnStart`**, bukan di data source — ini harus jadi tabel di MySQL.

### 2.3 Arsitektur Data: Model Stok Turunan

Ini adalah keputusan desain paling menentukan di aplikasi eksisting dan wajib dipahami sebelum migrasi.

**Volume silo tidak pernah disimpan.** Kolom `Silo_Master.vol_aktual_ltr` ada tapi tidak dipakai sebagai sumber kebenaran. Setiap kali volume ditampilkan, dia dihitung ulang:

```
Volume Buffer (silo "000")  = SUM(FM_Receiving_Penerimaan.qty_remaining_ltr)
                              WHERE silo_number = '000'
                                AND status_fifo = 'ACTIVE'
                                AND status_approval NOT IN ('Rejected','REVISED','VOIDED')

Volume Silo Penyimpanan(X)  = SUM(FM_Prepast_Record.qty_remaining_ltr)
                              WHERE silo_tujuan = X
                                AND status_fifo = 'ACTIVE'
                                AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
```

Pola filter empat-kondisi ini muncul **lebih dari 30 kali** di seluruh YAML — di label kapasitas, persentase, daftar supplier, validasi submit, dan guard navigasi. Setiap salinannya adalah kesempatan untuk salah ketik, dan memang ada varian yang filternya tidak lengkap (mis. `lblSiloCapacity` di `Scr_Receiving_Input` hanya memfilter `status_fifo`, mengabaikan `status_approval`).

Di MySQL, ini menjadi **satu VIEW** (`v_silo_volume`) dan seluruh duplikasi hilang.

### 2.4 Alur Bisnis Inti

```
                     [ SUPPLIER / TRUK ]
                             │
                             ▼
                   ┌──────────────────┐
                   │  RECEIVING       │  RCV-yyyymmdd-NNN
                   │  → Buffer "000"  │  qty_kg ÷ berat_jenis = qty_ltr
                   └────────┬─────────┘  buffer_status: IN_BUFFER
                            │
                            │  konsumsi qty_remaining_ltr induk
                            ▼
                   ┌──────────────────┐
                   │  PREPAST         │  PST-yyyymmdd-NNN
                   │  Buffer → Silo N │  set StandingTimeAnchor bila silo kosong
                   └────────┬─────────┘  status_fifo: ACTIVE
                            │
                            │  alokasi FIFO lintas beberapa PST
                            ▼
                   ┌──────────────────┐
                   │  TRANSFER        │  TRF-yyyymmdd-NNN
                   ├──────────────────┤
                   │ PEMAKAIAN        │──► Tank produksi (MT/CMD) + Batch
                   │ PRODUKSI         │
                   ├──────────────────┤
                   │ PINDAH SILO      │──► Silo lain: bikin PST anak baru
                   └──────────────────┘     + wariskan StandingTimeAnchor

    Paralel:  MONITORING (pH/suhu per silo, ambang 4 jam / 2 jam untuk SILO 25A-25B)
              STOCK OPNAME (snapshot bulanan per silo)
              APPROVAL (SPV menyetujui/menolak tiap record di 4 modul)
```

### 2.5 Model Alokasi FIFO

Saat operator mengisi volume transfer, aplikasi menghitung alokasi terhadap batch prepast di silo tersebut, diurutkan **`prepast_finish` menaik** (yang paling lama masuk, keluar duluan):

```
untuk setiap batch prepast ke-i (urut FIFO):
    volSebelumnya = Σ qty_remaining_ltr batch 1..i-1
    sisaUntukItem = MAX(volTransfer - volSebelumnya, 0)
    dialokasikan  = MIN(qty_remaining_ltr[i], sisaUntukItem)
    jika dialokasikan > 0:
        catat { id_prepast, supplier_code, qty_allocated, qty_after, status_after }
```

Hasilnya di-serialisasi sebagai **JSON string** ke kolom `FM_Receiving_Transfer.supplier_fifo`. JSON inilah yang kemudian di-`ParseJSON()` untuk melakukan rollback saat transfer di-void atau dikoreksi. Karena JSON disimpan sebagai teks, pencarian dependensi dilakukan dengan operator `in` (substring match) — rawan false positive.

### 2.6 Status Lifecycle

Tiga dimensi status berjalan bersamaan pada record transaksi:

| Dimensi | Nilai | Makna |
|---|---|---|
| `status_approval` | `Pending Approval` → `Approved` \| `Rejected` \| `Edit Requested` \| `REVISED` \| `VOIDED` | Jejak persetujuan & pembatalan |
| `status_fifo` | `ACTIVE` \| `CLOSED` | Apakah sisa volume masih boleh dialokasikan |
| `buffer_status` | `IN_BUFFER` \| `IN_PREPAST` \| `COMPLETED` | Posisi batch receiving di buffer (khusus Receiving) |

`REVISED` menandai record lama yang digantikan record koreksi. `VOIDED` menandai pembatalan manual dengan rollback. Keduanya sama-sama dikecualikan dari perhitungan volume.

### 2.7 Mekanisme Koreksi & Void

Aplikasi **tidak pernah mengedit record transaksi di tempat** (kecuali kasus GANTUNG). Koreksi dilakukan dengan pola *reversal + re-entry*:

**Koreksi Receiving:** buat record RCV baru → tandai record lama `REVISED` + `status_fifo=CLOSED` + `qty_remaining_ltr=0`.

**Koreksi Prepast:** buat record PST baru → tandai PST lama `REVISED` → kembalikan selisih volume ke induk Receiving (`qty_remaining + (vol_lama − vol_baru)`), sesuaikan ulang `buffer_status` dan `status_fifo` induk.

**Koreksi Transfer:** reversal dijalankan di `OnVisible` layar, **sebelum** baseline FIFO dihitung ulang — parse `supplier_fifo` lama, kembalikan `qty_allocated` ke tiap PST sumber dan set `ACTIVE`; bila jenisnya PINDAH SILO, void juga PST anak yang tercipta di silo tujuan; tandai transfer lama `REVISED`. Flag `varTfReversalDone` mencegah reversal berjalan dua kali.

**Void:** logika serupa, dijalankan dari `Scr_DataList`, mengembalikan volume ke hulu lalu menandai record `VOIDED`.

**Dependency guard:** record tidak bisa diedit atau di-void bila punya turunan aktif — Receiving terkunci bila ada Prepast anak, Prepast terkunci bila `Title`-nya muncul di `supplier_fifo` suatu Transfer. Popup WARNING menampilkan daftar turunan yang harus di-void lebih dulu.

### 2.8 Standing Time

`Silo_Master.StandingTimeAnchor` (DateTime) menandai kapan susu mulai "berdiri" di silo:

- **Di-set** saat prepast pertama masuk ke silo yang anchor-nya kosong, bernilai waktu `prepast_finish`.
- **Direset ke NULL** saat transfer mengosongkan silo (`volTransfer == volAktual`).
- **Diwariskan** ke silo tujuan pada PINDAH SILO penuh; bila transfernya sebagian, silo tujuan mendapat anchor `Now()`.
- Disimpan per-transfer sebagai `standing_time_menit = DateDiff(anchor, waktu_transfer)`.

### 2.9 Fitur "GANTUNG"

Operator boleh menyimpan record Prepast atau Transfer tanpa mengisi jam mulai/selesai dengan menandainya GANTUNG (`is_gantung = true`). Record tersebut tampil berlabel `GANTUNG` di DataList, dan saat diedit masuk ke mode `varCompleteGantung` — satu-satunya jalur yang melakukan **update in-place tanpa reversal dan tanpa membuat record baru**. Setelah lengkap, `is_gantung` di-set `false`.

### 2.10 Peran & Otorisasi

| Role | Kemampuan |
|---|---|
| **Operator** | Input semua modul; edit record berstatus `Pending Approval`/`Rejected`; ajukan Request Edit untuk record `Approved` |
| **SPV** | Semua kemampuan Operator + approve/reject + edit record `Approved` + akses Approval & Export |
| **Admin** | Diarahkan ke Stock Opname, bukan Approval. `varIsAdmin` di-set tapi tidak membedakan perilaku apa pun di YAML selain routing tombol tersebut. |

**Admin bukan superset dari SPV.** Ini terlihat pada tombol navigasi `btnApproval` di dashboard, yang bercabang berdasarkan peran:

```
If(varCurrentUser.role.Value = "SPV",
    Navigate(Scr_Approval),      // SPV  → antrean approval
    Navigate(Scr_SO_Input)       // Admin → stock opname
)
```

Keduanya adalah peran penyelia dengan wilayah kerja berbeda, bukan dua tingkat dari hierarki yang sama. Pemisahan ini dikonfirmasi dan diformalkan pada 25 Agustus 2026 — lihat 2.10.1.

#### 2.10.1 Matriks Peran (Ditetapkan 25 Agustus 2026)

| Kemampuan | Operator | SPV | Admin |
|---|:---:|:---:|:---:|
| Input Receiving · Prepast · Transfer · Monitoring | ✅ | ✅ | — |
| Edit record `Pending Approval` / `Rejected` miliknya | ✅ | ✅ | — |
| Ajukan Request Edit atas record `Approved` | ✅ | — | — |
| Edit record `Approved` secara langsung | — | ✅ | — |
| **Approve / Reject** (satuan) | — | ✅ | — |
| **Approve massal** | — | ✅ | — |
| Tinjau & putuskan Request Edit | — | ✅ | — |
| **Void** (termasuk cascade void) | — | ✅ | — |
| **Stock Opname** — input volume awal bulan | — | — | ✅ |
| **Export data** — tugas harian | — | ✅ | ✅ |
| **Manajemen master data** (FR-26) | — | — | ✅ |
| Lihat dashboard & Data List | ✅ | ✅ | ✅ |

**Empat penegasan:**

1. **Approval, approve massal, dan void adalah wewenang SPV — tidak diwarisi Admin.** Ketiganya mengubah status persetujuan atau memutar balik volume; itu keputusan mutu, bukan keputusan administratif.
2. **Admin tidak melakukan input transaksi harian.** Satu-satunya input Admin adalah volume awal bulan pada Stock Opname. Perannya administratif dan periodik, bukan operasional harian.
3. **Tugas harian Admin adalah export data.** Menerbitkan form GMP untuk diarsipkan.
4. **Export terbuka untuk SPV dan Admin.** SPV memerlukannya untuk menerbitkan form mutu yang ditandatanganinya; Admin untuk pengarsipan rutin.

Pemisahan ini menghasilkan **pemisahan tugas (segregation of duties)** yang lebih tegas daripada aplikasi lama, dan berlapis tiga: yang menginput bukan yang menyetujui, yang menyetujui bukan yang menetapkan stok awal, dan yang mengelola master data tidak menyentuh transaksi sama sekali.

Autentikasi: dropdown nama operator + PIN 4 digit yang **dibandingkan sebagai plaintext** dengan `Operator_Master.pin_code`. Seluruh daftar operator beserta PIN-nya ter-download ke perangkat lewat `ClearCollect(colOperatorMaster, ...)`.

---

## 3. Motivasi Migrasi

| # | Masalah | Dampak Operasional | Bagaimana Migrasi Menyelesaikan |
|---|---|---|---|
| M-1 | **Tidak ada transaksi.** Submit transfer = 1 insert + N update `Patch()` berurutan. Gagal di tengah = stok salah permanen. | Selisih stok yang tidak bisa dijelaskan | Satu endpoint = satu transaksi MySQL, rollback otomatis |
| M-2 | **Batas delegasi SharePoint (2.000 baris).** Agregat `Sum()`/`Filter()` diam-diam memotong data. | Volume silo salah tanpa peringatan | Agregasi dieksekusi di MySQL, tanpa batas baris |
| M-3 | **Datetime sebagai string `"mm/dd/yyyy hh:mm"`.** Sorting butuh rekonstruksi manual `Mid()+Left()`. | Urutan FIFO bisa salah; filter tanggal tidak akurat | Kolom `DATETIME` + index |
| M-4 | **ID dari `RandBetween(100,999)`.** Ruang hanya 900 nilai per hari per modul. | Tabrakan ID; record saling menimpa | Sequence harian di server + `UNIQUE` constraint |
| M-5 | **Race condition alokasi FIFO.** Dua operator menyubmit transfer dari silo sama secara bersamaan tidak saling melihat. | Over-allocation, stok negatif | `SELECT … FOR UPDATE` pada baris prepast |
| M-6 | **Tidak ada integritas referensial.** Relasi hidup lewat pencocokan string dan substring JSON. | Data yatim; guard dependensi bisa meleset | Foreign key + tabel alokasi ternormalisasi |
| M-7 | **PIN plaintext ter-download ke klien.** | Siapa pun bisa login sebagai siapa pun | Hash argon2id + JWT, verifikasi di server |
| M-8 | **Logika terduplikasi di UI.** Filter status empat-kondisi tersebar >30 tempat, sebagiannya sudah tidak sinkron. | Angka berbeda antar layar untuk data yang sama | Satu VIEW, satu service layer |
| M-9 | **Refresh manual & Timer.** Pengguna harus menekan tombol refresh untuk melihat data terbaru. | Keputusan diambil atas data basi | Invalidasi cache React Query + polling terarah |

---

## 4. Ruang Lingkup

### 4.1 Termasuk

- Seluruh 14 screen, dipetakan ke route web
- Seluruh business rule di Bagian 6, dipertahankan persis
- Migrasi data historis dari 9 SharePoint List ke MySQL
- Autentikasi & otorisasi berbasis peran
- Export rekap Excel (menggantikan Power Automate)
- Responsive: tablet (utama, operator di lantai produksi) dan desktop (SPV)

### 4.2 Tidak Termasuk (Fase 1)

- Aplikasi mobile native
- Mode offline penuh
- Integrasi ERP/SAP
- Notifikasi push/email di luar export
- Modul `FM_Batch_Traceability` (lihat 4.3)

### 4.3 `FM_Batch_Traceability` — Ditunda ke Fase Lanjutan

**Keputusan (25 Agustus 2026): di luar cakupan Fase 1.**

Analisa kode mengonfirmasi bahwa tabel ini tidak pernah ditulis maupun dibaca oleh screen mana pun — tidak ada satu pun `Patch` atau `Filter` yang menyentuhnya. Ke-19 kolom bisnisnya (`batch_produk_jadi`, `id_receiving_list`, `supplier_composition`, `status_trace`, `tanggal_produksi`, dsb.) memang sudah dirancang, tetapi masih berstatus draft.

Secara proses, traceability adalah **kelanjutan hilir dari FM Receiving**: begitu susu ditransfer ke tank produksi, modul ini menjawab dipakai untuk memproduksi produk apa dan menghasilkan batch produk jadi apa. Dengan kata lain ia menyambung ke titik akhir rantai yang sudah ada:

```
Receiving → Prepast → Transfer → [ TANK PRODUKSI ] ─┐
                                                     │  ← batas cakupan Fase 1
                                                     ▼
                                              BATCH TRACEABILITY
                                              (produk jadi + komposisi supplier)
```

Prioritasnya adalah memantapkan FM Receiving lebih dulu, karena kualitas data traceability sepenuhnya bergantung pada akurasi alokasi FIFO di hulu. Membangun penelusuran di atas data alokasi yang belum transaksional hanya akan memindahkan masalahnya ke hilir.

**Konsekuensi untuk Fase 1:**

- Data historis tetap dimigrasikan ke tabel `batch_traceability` apa adanya, sebagai penyimpanan read-only. Tidak ada yang hilang.
- Kolom `transfer.id` sudah menjadi titik sambung alami; tabel `transfer_allocation` (Bagian 8.2) menyimpan komposisi supplier per transfer secara ternormalisasi — persis data yang dibutuhkan `supplier_composition` nantinya, tanpa perlu parsing JSON.
- Tidak ada UI yang dibangun. Estimasi 13 minggu di Bagian 12 tetap.

**Prasyarat sebelum fase lanjutan dimulai:** wawancara proses produksi untuk memetakan hubungan batch produksi ↔ produk jadi, dan menentukan apakah penelusuran bersifat maju (dari supplier ke produk) saja atau juga mundur (dari produk ke supplier) — yang kedua menuntut indeks tambahan tetapi tidak mengubah skema.

---

## 5. Functional Requirements

Notasi: **P0** wajib untuk go-live · **P1** penting · **P2** nice to have.

### FR-1 Autentikasi & Sesi

| ID | Requirement | Prioritas |
|---|---|---|
| FR-1.1 | Login memakai PIN yang di-hash (argon2id), diverifikasi **di server**. Klien tidak pernah menerima daftar PIN. | P0 |
| FR-1.2 | Sesi via JWT (access 15 menit + refresh token httpOnly), auto-logout setelah 8 jam idle. | P0 |
| FR-1.3 | Untuk kesetaraan UX, layar login tetap menampilkan dropdown nama operator aktif (endpoint publik yang hanya mengembalikan `id` + `nama_lengkap`, tanpa PIN). | P0 |
| FR-1.4 | Semua route selain login dilindungi; klaim `role` menentukan hak akses. | P0 |
| FR-1.5 | Kebijakan PIN dinaikkan menjadi 6 digit dengan rate limit 5 percobaan gagal per 15 menit. | P1 |

> Aplikasi eksisting menampilkan overlay "404 Not Found" ketika `varSessionValid` bernilai false — ini pengganti route guard. Di web, gunakan redirect ke `/login` yang sesungguhnya.

### FR-2 Dashboard (Home)

| ID | Requirement | Prioritas |
|---|---|---|
| FR-2.1 | Tampilkan kartu untuk tiap silo aktif berisi: nama, volume aktual / kapasitas maksimum, persentase isi, jumlah supplier aktif. | P0 |
| FR-2.2 | Tiap kartu menampilkan pH, suhu, dan TS terakhir. Bila volume = 0 atau belum ada monitoring, tampilkan `N/A`. TS adalah **rata-rata `nilai_ts` seluruh batch prepast aktif** di silo tersebut. | P0 |
| FR-2.3 | Status monitoring: `Silo kosong` (vol=0) · `Belum pernah dicek!` · `Perlu dicek! (>N jam)` · `OK - N jam lalu`. Ambang N = **2 jam untuk SILO 25A & 25B, 4 jam untuk lainnya**. | P0 |
| FR-2.4 | Tampilkan standing time terformat: `Xh Yj Zm` (≥1 hari) · `Yj Zm` (≥1 jam) · `Z menit`. Bila anchor kosong tampilkan `-`. | P0 |
| FR-2.5 | Header agregat: total volume seluruh silo penyimpanan / total kapasitas (silo `000` dikecualikan dari keduanya). | P0 |
| FR-2.6 | Navigasi modul: Receive, Prepast, Transfer, Monitor, Edit Data. Approval/Stock Opname & Export hanya untuk non-Operator. | P0 |
| FR-2.7 | Badge hitungan: SPV melihat `List Antre Approval (n)` sebagai jumlah pending di 4 modul; Operator melihat `List Antre Prepast (n)` yaitu jumlah batch buffer siap prepast. | P0 |
| FR-2.8 | Data ter-refresh otomatis tanpa aksi pengguna (menggantikan Timer 30 detik + tombol refresh manual). | P0 |
| FR-2.9 | Klik kartu silo membuka halaman detail silo. | P0 |

### FR-3 Pemilihan Silo (QR / Manual)

| ID | Requirement | Prioritas |
|---|---|---|
| FR-3.1 | Sediakan pemindai QR berbasis kamera (`getUserMedia` + pustaka decoder JS) dan dropdown manual sebagai fallback — persis seperti aplikasi lama yang menyediakan keduanya. | P0 |
| FR-3.2 | QR dicocokkan ke `Silo_Master.qr_code_value` dengan `is_active = true`. Tidak cocok → pesan error, tetap di halaman. | P0 |
| FR-3.3 | Routing setelah pemilihan bergantung modul aktif: Receiving/Prepast → cek `is_available`, tolak bila silo penuh · Monitoring → langsung lanjut · Transfer → cek volume > 0, tolak bila kosong · TransferTarget → tolak bila sama dengan silo asal atau bila silo `000`. | P0 |
| FR-3.4 | Pemindai tank terpisah untuk tujuan transfer produksi, mencocokkan ke master tank. | P0 |

### FR-4 Modul Receiving

| ID | Requirement | Prioritas |
|---|---|---|
| FR-4.1 | Silo tujuan **selalu buffer `000`** (dipaksa oleh sistem, tidak dapat dipilih operator). | P0 |
| FR-4.2 | Field: Supplier (dropdown aktif) · Quantity kg · Berat jenis · Nilai Total Solid · Finish time (tanggal + jam + menit terpisah). Semua wajib. | P0 |
| FR-4.3 | Tampilkan konversi live: `Qty Liter = FLOOR(qty_kg / berat_jenis)`. | P0 |
| FR-4.4 | Tampilkan kapasitas buffer tersisa = `kapasitas_maks − volume_aktual_buffer`. | P0 |
| FR-4.5 | Validasi: seluruh field terisi · nilai numerik > 0 · menit ≤ 59 · jam & menit tepat 2 digit. Terima koma maupun titik sebagai pemisah desimal. | P0 |
| FR-4.6 | Submit menghasilkan record: `status_approval='Pending Approval'`, `status_fifo='ACTIVE'`, `buffer_status='IN_BUFFER'`, `cmd_source='CMD1'`, `qty_remaining_ltr = qty_ltr`. | P0 |
| FR-4.7 | Mode koreksi: record lama menjadi `REVISED`/`CLOSED`/`qty_remaining=0`; record baru menyimpan `correction_ref` ke ID lama. Qty kg tidak dapat diubah saat koreksi. | P0 |

### FR-5 Modul Prepast

| ID | Requirement | Prioritas |
|---|---|---|
| FR-5.1 | Tampilkan antrean buffer: batch RCV di silo `000` dengan `status_fifo='ACTIVE'`, `qty_remaining_ltr > 0`, status approval tidak dikecualikan — **diurutkan menaik berdasarkan waktu penerimaan (FIFO)**. | P0 |
| FR-5.2 | Memilih batch akan menampilkan form dengan volume default = sisa penuh batch tersebut. | P0 |
| FR-5.3 | Field: Volume · Silo tujuan (bukan `000`) · Start & finish time · Flowrate · Temp after heater · Temp output · Remarks (opsional). | P0 |
| FR-5.4 | Validasi: silo tujuan bukan buffer · volume > 0 · volume ≤ sisa batch induk · waktu lengkap kecuali ditandai GANTUNG · jam/menit 2 digit. | P0 |
| FR-5.5 | **Rollover tengah malam:** bila tanggal finish ≤ tanggal start dan jam finish < jam start, tanggal finish otomatis +1 hari. | P0 |
| FR-5.6 | Submit mengurangi `qty_remaining_ltr` batch induk; bila mencapai 0, induk menjadi `buffer_status='COMPLETED'` + `status_fifo='CLOSED'`, selain itu `IN_PREPAST`/`ACTIVE`. | P0 |
| FR-5.7 | Bila `StandingTimeAnchor` silo tujuan kosong, set ke waktu finish prepast. | P0 |
| FR-5.8 | Toggle GANTUNG menyimpan record tanpa waktu; dilengkapi belakangan lewat update in-place. | P0 |
| FR-5.9 | Koreksi: PST lama menjadi `REVISED`, selisih volume dikembalikan ke induk Receiving, status induk dihitung ulang. | P0 |

### FR-6 Modul Transfer

| ID | Requirement | Prioritas |
|---|---|---|
| FR-6.1 | Dua jenis: **PEMAKAIAN PRODUKSI** (ke tank, wajib batch number) dan **PINDAH SILO** (ke silo lain, batch otomatis `"TF TO <silo>"`). | P0 |
| FR-6.2 | Tampilkan pratinjau FIFO: tiap batch prepast aktif dengan supplier, sisa volume, dan waktu masuk — diurutkan `prepast_finish` menaik. | P0 |
| FR-6.3 | Saat volume diisi, hitung alokasi FIFO secara live (algoritma di 2.5) dan tampilkan sisa yang belum teralokasi. | P0 |
| FR-6.4 | Validasi: volume > 0 · volume ≤ volume aktual silo · alokasi FIFO tuntas (sisa = 0) · tujuan terisi · batch terisi untuk PEMAKAIAN PRODUKSI · jam/menit 2 digit. | P0 |
| FR-6.5 | Submit mengurangi `qty_remaining_ltr` tiap prepast teralokasi dan menutupnya bila mencapai nol. | P0 |
| FR-6.6 | `cmd_destination` = `CMD2` bila tank tujuan CMD 2, selain itu `CMD1`. | P0 |
| FR-6.7 | **Rollover tanggal transfer:** bila waktu transfer jatuh sebelum `StandingTimeAnchor`, tanggal +1 hari. | P0 |
| FR-6.8 | Simpan `standing_time_menit = DateDiff(anchor, waktu_transfer_final)`. | P0 |
| FR-6.9 | Transfer penuh (volume = volume aktual) mereset `StandingTimeAnchor` silo asal ke NULL. | P0 |
| FR-6.10 | PINDAH SILO membuat satu record prepast baru per baris alokasi di silo tujuan, membawa `supplier_code` asal dan `transfer_ref = "<asal>-TO-<tujuan>"`. | P0 |
| FR-6.11 | Anchor silo tujuan: diwariskan dari silo asal bila transfer penuh, `Now()` bila sebagian — hanya diterapkan bila anchor tujuan masih kosong. | P0 |
| FR-6.12 | Koreksi menjalankan reversal penuh sebelum entri baru (lihat 2.7); reversal harus idempoten. | P0 |
| FR-6.13 | Toggle GANTUNG tersedia; pelengkapan memperbarui `trf_time` dan `standing_time_menit` in-place. | P0 |

### FR-7 Modul Monitoring

| ID | Requirement | Prioritas |
|---|---|---|
| FR-7.1 | Tampilkan silo terpilih, volume aktual, dan daftar supplier aktif berformat `"Nama (X L), Nama (Y L)"`. | P0 |
| FR-7.2 | Field: pH · suhu · waktu cek (tanggal + jam + menit). Semua wajib. | P0 |
| FR-7.3 | Simpan `supplier_list` dan `val_aktual_snapshot_ltr` sebagai snapshot pada saat pengecekan. | P0 |
| FR-7.4 | Koreksi membuat record baru dan menandai yang lama `REVISED`. | P0 |
| FR-7.5 | Beri peringatan visual bila pH di luar 6,0–7,0 (rentang ini sudah tertulis di hint field tapi tidak pernah divalidasi). | P1 |

### FR-8 Stock Opname

**Akses: Admin.** Lihat matriks peran 2.10.1.

| ID | Requirement | Prioritas |
|---|---|---|
| FR-8.1 | Periode berformat `YYYY-MM`, default bulan berjalan. | P0 |
| FR-8.2 | Tampilkan seluruh silo aktif kecuali `000`, prefill dengan nilai SO yang sudah ada untuk periode tersebut. | P0 |
| FR-8.3 | Bila periode sudah difinalisasi, field menjadi read-only dan status ditampilkan. | P0 |
| FR-8.4 | Save melakukan **upsert per (periode, silo)** — update bila ada, insert bila belum. | P0 |
| FR-8.5 | Validasi memblokir penyimpanan bila ada silo yang belum diisi. | P0 |

> **Catatan bug:** logika upsert eksisting rusak — `If(silo_number, Patch(..., LookUp(FM_Stock_Opname, ID = silo_number), ...))` menggunakan `silo_number` (string) sebagai kondisi boolean sekaligus mencocokkannya ke kolom `ID` (angka). Selain itu, `Notify()` validasi tidak menghentikan eksekusi, sehingga penyimpanan tetap berjalan meski ada field kosong. Keduanya harus diperbaiki, bukan direplikasi.

**Catatan implementasi (F3-1, selesai 25 Ags 2026).**
`server/src/services/stockOpname.js`, `routes/stockOpname.js`,
`client/src/pages/StockOpname.jsx`. Keduanya diperbaiki secara struktural,
bukan ditambal:

| Bug | Perbaikan |
|---|---|
| B-2, upsert tidak pernah bekerja | Keunikan ditegakkan BASIS DATA lewat `UNIQUE (periode, silo_id)` dan `INSERT ... ON DUPLICATE KEY UPDATE`, bukan oleh formula pencarian yang harus ditulis benar setiap kali |
| B-3, validasi tidak menghentikan penyimpanan | Menyimpan dan mengunci DIPISAH (WF-12). Menyimpan satu baris tidak menuntut kelengkapan; memfinalisasi periode menuntutnya dan menyebut nama silo yang belum dihitung |

**Nol berbeda dari kosong, dan perbedaan itu inti FR-8.5.** Silo yang benar-benar
kosong saat dihitung adalah hasil yang sah; kosong berarti belum dihitung.
Karena itu volume awal memakai validator tersendiri yang menerima nol, tidak
memakai `angkaDesimal` yang dipakai modul lain dan menolak nol. Di antarmuka,
mengosongkan field tidak menyimpan nol, ia tidak menyimpan apa pun.

**Nilai di atas batas keras silo ditolak, bukan diperingatkan.** Hasil hitung
yang melebihi kapasitas ditambah toleransi pasti salah ketik, dan angka itu
kelak menjadi dasar saldo berjalan (L-1).

**Finalisasi dicatat satu jejak per baris**, bukan sekali untuk periodenya.
`audit_log.entity_id` sengaja NOT NULL supaya tiap jejak menunjuk record
tertentu; jejak yang menggantung tanpa record akan luput dari pertanyaan "apa
saja yang pernah terjadi pada record ini" (21 CFR Part 11 sec.11.10(e)).
Konteks periodenya disertakan pada tiap jejak.

**Belum ada: membuka kembali periode yang sudah difinalisasi.** BR-20 menyatakan
read-only setelah final dan tidak menyebut jalan kembali, jadi jalan itu tidak
dibuat. Bila hasil hitung fisik ternyata perlu dikoreksi, itu keputusan mutu
yang perlu diputuskan lebih dahulu sebelum sistem menyediakan tombolnya.

### FR-9 Approval

**Akses: SPV semata — tidak diwarisi Admin (BR-22).**

| ID | Requirement | Prioritas |
|---|---|---|
| FR-9.1 | Empat tab (Receive · Prepast · Monitor · Transfer), masing-masing menampilkan antrean `Pending Approval` dengan hitungan. | P0 |
| FR-9.2 | Approve mengisi `status_approval='Approved'`, `approved_by`, `approved_at`. | P0 |
| FR-9.3 | Reject wajib disertai komentar, mengisi `rejection_comment`. | P0 |
| FR-9.4 | **Guard reject:** Receiving tidak dapat direject bila punya Prepast anak aktif; Prepast tidak dapat direject bila direferensikan Transfer aktif. Tampilkan pesan yang menyebutkan apa yang harus direject lebih dulu. | P0 |
| FR-9.5 | Bagian Edit Request menampilkan record `Edit Requested` beserta alasan operator. Menyetujui mengembalikan ke `Pending Approval` (membuka kunci edit); menolak mengembalikan ke `Approved`. | P0 |
| FR-9.6 | Reject harus tersedia di keempat modul. | P0 |

> **Catatan bug:** di aplikasi eksisting, tombol reject hanya terlihat di tab Monitoring (`Visible: =false` pada tiga tab lain), hitungan Edit Request tab Prepast salah menghitung koleksi Transfer, dan tombol "No" pada dialog Edit Request menampilkan toast "Edit Request Approved". Ketiganya diperbaiki di versi web.

### FR-10 Data List & Koreksi

| ID | Requirement | Prioritas |
|---|---|---|
| FR-10.1 | Empat tab, tiap record menampilkan ID, deskripsi, volume, waktu, dan status. Record GANTUNG diberi label `GANTUNG`. | P0 |
| FR-10.2 | Visibilitas Edit — SPV: `Pending Approval`, `Approved`, `Rejected`. Operator: `Pending Approval`, `Rejected`. | P0 |
| FR-10.3 | Visibilitas Void — SPV: + `Edit Requested`. Operator: sama seperti Edit. | P0 |
| FR-10.4 | Operator dapat mengajukan Request Edit disertai alasan untuk record `Approved`. | P0 |
| FR-10.5 | Klik Edit pada record GANTUNG masuk ke mode pelengkapan (update in-place, tanpa reversal). | P0 |
| FR-10.6 | Guard dependensi memblokir Edit dan Void, menampilkan daftar record turunan yang harus ditangani lebih dulu. | P0 |
| FR-10.7 | Void menjalankan cascade rollback sesuai 2.7. | P0 |
| FR-10.8 | Sediakan filter (tanggal, status, supplier, silo) dan pencarian berdasarkan ID. | P1 |
| FR-10.9 | Sediakan pagination — daftar saat ini memuat seluruh tabel ke memori klien. | P0 |

### FR-11 Detail Silo

| ID | Requirement | Prioritas |
|---|---|---|
| FR-11.1 | Buffer `000` menampilkan tab Receiving; silo penyimpanan menampilkan tab Prepast, Monitoring, Transfer. | P0 |
| FR-11.2 | Tiap tab menampilkan riwayat terurut waktu menurun beserta status FIFO & approval. | P0 |
| FR-11.3 | Filter berfungsi penuh: rentang tanggal, status, supplier. | P0 |

> **Catatan bug:** filter tanggal eksisting menggunakan `StartsWith(finish_time, Text(tanggal, "mm"))` — hanya mencocokkan bulan, bukan tanggal, dan cocok juga ke tahun lain.

**Catatan implementasi (F2-12, selesai 25 Ags 2026).** `GET /silos/:id` hanya
mengembalikan KEPALA halaman: identitas silo, angka volume, tab yang berlaku,
dan supplier yang benar-benar pernah masuk silo itu. Riwayat transaksinya
diambil lewat `/data/:modul?siloId=` yang sudah berpaginasi dan berfilter,
bukan lewat kueri baru. Menyalin kueri riwayat ke endpoint sendiri berarti dua
tempat yang harus dijaga tetap serupa, dan justru itulah asal B-7: filternya
ditulis ulang di layar detail, lalu salah.

Aksi koreksi dan pembatalan sengaja tidak dipasang di halaman ini. Halaman
Detail Silo untuk membaca riwayat satu silo; tombol wewenang yang sama di dua
tempat berarti dua tempat yang harus sepaham soal peran, dan kondisi itulah
yang membuat B-22 mungkin terjadi.

**B-7 ternyata punya kembaran di sistem baru.** Saat menguji filternya, rentang
"25 Agustus sampai 25 Agustus" mengembalikan **nol baris**. Sebabnya bukan
formula Power Fx, melainkan JavaScript: `<input type="date">` mengirim
`2026-08-25`, dan `new Date('2026-08-25')` berarti tengah malam **UTC**, bukan
tengah malam setempat. Lebih buruk lagi, batas atas dari tanggal saja berarti
AWAL hari, bukan akhirnya. Filter yang mengembalikan nol tidak terlihat rusak,
ia terlihat seperti tidak ada data, dan itulah yang membuatnya berbahaya.

Perbaikannya `batasTanggal(nilai, sisi)` di `services/waktu.js`: tanggal saja
ditafsirkan sebagai HARI SETEMPAT, batas bawah 00.00.00.000 dan batas atas
23.59.59.999, sementara nilai yang sudah memuat jam dibiarkan apa adanya.
Delapan uji menyertainya, termasuk uji yang memastikan seluruh jam pada hari
itu tercakup. Karena kolom DATETIME menyimpan UTC (A-4), penafsiran hari
setempat inilah yang sesuai dengan cara operator membaca kalender, dan
konversinya diserahkan ke driver.

**Filter baru.** `siloId` dan `supplierId` pada `receiving`, `supplierId` pada
`prepast`. Sebelumnya `receiving` tidak dapat disaring per silo sama sekali,
sehingga tab Penerimaan pada buffer tidak mungkin dibuat tanpa kueri baru.

**Bug sesi yang ikut tertangkap.** Selama menguji halaman ini, setiap reload
melempar pengguna kembali ke layar login. Penyebabnya bukan cookie maupun
proxy: `lib/auth.jsx` memanggil `fetch('/api/v1/auth/refresh')` sendiri,
sehingga penjaga dedupe di `lib/api.js` tidak berlaku baginya. Refresh token
dirotasi di server, jadi panggilan kedua memakai token yang sudah dicabut,
gagal 401, dan sesi yang sah dibuang. StrictMode React memasang effect dua kali
di mode pengembangan, jadi gejalanya muncul di setiap muat halaman.

Perbaikannya `pulihkanSesi()` di `lib/api.js`: satu jalur refresh, dan janjinya
disimpan permanen selama halaman hidup, bukan direset setelah selesai, karena
pemulihan sesi memang hanya terjadi sekali per muat halaman. Terverifikasi:
reload penuh kini memicu tepat satu panggilan refresh dan sesinya bertahan.

Perlu dicatat bahwa ini **kelas bug yang sama dengan yang ditemukan di F2-9**:
logika bersama ditaruh di satu jalur, lalu jalur kedua memanggil lapis di
bawahnya secara langsung dan melewatinya. Di server bentuknya skema zod di
lapis rute, di klien bentuknya penjaga dedupe di lapis api. Keduanya hanya
menjaga pemanggil yang lewat pintu depan.

> **Terbuka: rotasi refresh token dan sesi ganda.** Dedupe di klien hanya
> berlaku dalam satu konteks JavaScript. Dua tab, atau dua tablet dengan akun
> yang sama, tetap dapat berlomba dan salah satu akan kehilangan sesinya.
> Pilihannya: (a) tetap sekali pakai dan terima konsekuensinya, yang paling
> ketat secara keamanan; atau (b) beri masa tenggang pendek sehingga token yang
> baru saja dirotasi masih diterima sekali. Belum diputuskan; belum menghalangi
> apa pun karena satu operator memakai satu tablet.

### FR-12 Export

**Akses: SPV dan Admin.**

| ID | Requirement | Prioritas |
|---|---|---|
| FR-12.1 | Rentang: Daily · Weekly (7 hari) · Monthly (sampai akhir bulan). Tampilkan pratinjau tanggal akhir & jumlah file. | P0 |
| FR-12.2 | Export dijalankan di server (`exceljs`), menghasilkan file yang setara dengan output Power Automate. | P0 |
| FR-12.3 | Job berjalan asinkron dengan indikator progres; file dapat diunduh langsung dari browser. | P0 |
| FR-12.4 | Notifikasi email opsional; unduhan langsung adalah jalur utama. | P1 |

> **Flow `ExportRekapFM` sudah dibaca.** Definisinya tersedia di
> `reference/export-logic/` (paket Power Automate, 25 Ags 2026), dan seluruh
> logika seleksi serta transformasinya diuraikan di 12A di bawah. Tata letak
> selnya diambil dari berkas hasil export sungguhan di
> `reference/export-samples/`, karena Office Script yang menulis sel tidak
> ikut dalam paket (hanya `scriptId`-nya).

### FR-12A Logika Flow Export Lama, Sebagaimana Adanya

Bagian ini adalah acuan perilaku untuk F3-2 dan F3-3. Yang perlu **dipertahankan** dan yang perlu **diperbaiki** dibedakan tegas, sebab form ini catatan mutu terkendali: menyimpang tanpa sadar sama buruknya dengan mempertahankan kesalahan.

**Alur pokok.** Trigger menerima `start_date`, `end_date`, `user_email`. Sebuah `Do_until` berjalan per hari dari `start_date` sampai `varPreviousDate >= end_date`, dibatasi 50 iterasi dan 2 jam. Tiap iterasi mengambil data satu hari, menyalin template `CMD1_FRM_PRD_01.xlsx`, menjalankan Office Script untuk mengisinya, lalu menambah satu baris ke ringkasan email. Setelah selesai, satu email berisi tabel tautan dikirim bila ada minimal satu berkas.

**Seleksi data per hari.**

| Modul | Filter sumber | Filter tanggal |
|---|---|---|
| Receiving | `status_approval` = Approved atau Pending Approval, `$top` 5000 | `substring(start_time, 0, 10)` sama dengan hari itu, dan panjang `start_time` >= 10 |
| Prepast | idem | `prepast_start` pada hari **sebelumnya, hari itu, atau hari sesudahnya** |
| Monitoring | idem | `substring(time_check, 0, 10)` sama dengan hari itu |
| Transfer | `transfer_type` = PEMAKAIAN PRODUKSI **dan** status Approved **atau** status Pending | `substring(trf_time, 0, 10)` sama dengan hari itu |

**Yang dipertahankan.**

| Perilaku | Alasan |
|---|---|
| Satu berkas per hari, `Rekap_FM_yyyyMMdd.xlsx` | Form terkendali diterbitkan harian; D-14 |
| Bentrok nama diberi sufiks `_2`, `_3`, ... | Berkas lama tidak pernah ditimpa. Penting untuk catatan mutu |
| `Pending Approval` ikut terbit | D-12. Form mengikuti realita operasional harian |
| Prepast mengikuti hari batch induknya | Lihat kotak "Tanggal patokan" di bawah. Jendela tiga hari flow lama hanya prefilter, bukan aturan |
| Prepast digabung per batch penerimaan | Satu baris form mewakili satu batch, bukan satu tujuan silo |
| Volume prepast dijumlahkan saat digabung | Satu batch yang dipecah ke tiga silo tetap satu jumlah |
| Waktu, flowrate, dan suhu: nilai pertama yang tidak kosong | Satu baris form hanya punya satu kolom untuk masing-masingnya |
| Monitoring & transfer diurutkan menurut waktu | Form dibaca berurutan waktu |
| Hari tanpa penerimaan tidak menghasilkan berkas | Terlihat nyata: 3, 17, 18, 19 Agustus tidak ada berkasnya |
| Slot `0 / 0 / 0` sebagai PENANDA SILO KOSONG | Lihat kotak di bawah. Ini datum, bukan derau |

**Yang diperbaiki.** Masing-masing menjadi bug bernomor di 14.3 dan uji di 18.

| # | Perilaku lama | Akibat |
|---|---|---|
| B-16 | `reportDate` dikirim `dd/MM/yyyy` sebagai teks | Tanggal 1-12 tersimpan **tertukar hari dan bulan**; tanggal 13+ tersimpan sebagai teks |
| B-23 | `$filter` transfer: `A and B or C` | `or` mengikat lebih longgar, jadi terbaca `(PEMAKAIAN PRODUKSI dan Approved) atau (Pending apa pun)`. PINDAH SILO yang masih pending ikut terbit sebagai pemakaian |
| B-24 | `silo_list` disambung `/` tanpa dedupe | `SILO25A/25A` |
| B-25 | `$top: 5000` tanpa paginasi | Pemotongan senyap begitu data melewatinya |
| B-27 | `Condition_HasData` hanya melihat jumlah penerimaan | Hari dengan monitoring dan transfer tetapi tanpa penerimaan tidak menghasilkan berkas sama sekali |
| B-28 | Enam sheet per berkas, empat di antaranya template kosong | Ukuran berkas dan kebingungan pembaca |
| B-29 | Prepast diprefilter tiga hari, lalu dicocokkan `id_receiving` | Prepast yang dikerjakan lebih dari sehari setelah penerimaan luput; baris form terbit dengan kolom prepast kosong |

> **B-16 terbukti di data, bukan disimpulkan dari kode.** Dari 20 berkas Agustus, sel tanggal pada 11 berkas memuat tanggal yang **salah** karena hari dan bulannya tertukar: `Rekap_FM_20260806.xlsx` memuat 8 Juni, dan `Rekap_FM_20260801.xlsx` memuat 8 Januari. Hanya 8 Agustus benar, dan itu kebetulan karena hari dan bulannya sama. Berkas tanggal 13 ke atas menampilkan tanggal yang benar tetapi sebagai teks, sebab 13 tidak dapat ditafsirkan sebagai bulan. Ini catatan mutu tertandatangani dengan tanggal yang salah pada sekitar sepertiga hari kerja, dan pantas diperbaiki di Power Apps segera, tidak menunggu migrasi.

> **Slot `0 / 0 / 0` adalah PENANDA SILO KOSONG, bukan slot kosong.**
> Ditegaskan pemilik proses, 25 Ags 2026, setelah dokumen ini sempat mencatatnya
> sebagai bug (B-26, dicabut). Satu slot berisi nol pada ketiga kolomnya
> menandai bahwa silo mencapai posisi kosong pada transfer sebelumnya.
>
> Kekeliruan itu pantas dicatat beserta cara membantahnya, sebab bacaan pertama
> tampak wajar: nol yang tidak berarti apa-apa. Yang membantahnya ada di data.
> Pada berkas 6 Agustus, Silo 25B memuat empat transfer, lalu penanda pada
> pukul 03.00, lalu silonya diisi lagi dan dipakai lagi dari 15.10 sampai
> 17.20, dan penanda kedua sesudahnya. Penandanya duduk di TENGAH urutan, jadi
> ia tidak mungkin sekadar sisa slot yang belum terpakai. Sebaliknya Silo 25A
> pada hari yang sama memuat sembilan transfer tanpa satu pun penanda, sebab ia
> tidak pernah kosong.
>
> Penanda ini datum penelusuran, bukan hiasan: ia batas ketiadaan carry-over.
> Susu yang keluar setelah penanda adalah susu baru, dan itulah yang ditanyakan
> saat penelusuran batch. Menghapusnya seperti rencana semula akan menghilangkan
> informasi yang tidak dapat direkonstruksi dari kolom lain mana pun.
>
> Sumbernya `transfer.vol_akt_silo_ltr`, snapshot volume SEBELUM transfer, jadi
> sisanya dihitung dengan menguranginya dan penanda diterbitkan ketika hasilnya
> nol. Penanda ikut memakan satu dari 21 slot per silo.
>
> Batasan yang diketahui: penanda hanya dapat menyusul baris PEMAKAIAN, sebab
> hanya di situ form menyediakan slot. Silo yang menjadi kosong akibat pindah
> silo tercatat di catatan bawah form (D-16), bukan sebagai penanda.

> **Tanggal patokan form adalah waktu SELESAI PENERIMAAN.** Ditegaskan pemilik
> proses, 25 Ags 2026. Satu baris form adalah satu batch penerimaan, dan hari
> terbitnya ditentukan oleh `finish_time` batch itu - bukan oleh kapan
> prepastnya dikerjakan. Penerimaan yang selesai 10 Agustus 23.30 lalu
> diprepast 11 Agustus 01.00 tetap terbit di form **10 Agustus**, lengkap
> dengan jam prepast 01.00 pada kolomnya.
>
> Karena itu prepast **tidak difilter tanggal sama sekali** di sistem baru; ia
> diambil sebagai anak dari batch penerimaan yang sudah terpilih, lewat
> foreign key. Jendela tiga hari pada flow lama (hari sebelum, hari itu, hari
> sesudah) hanyalah prefilter murah sebelum pencocokan `id_receiving`, bukan
> aturan bisnis - dan prefilter itu punya celah sendiri: prepast yang
> dikerjakan lebih dari satu hari setelah penerimaannya, misalnya batch yang
> menginap di buffer, luput dari jendela sehingga baris formnya terbit dengan
> kolom prepast kosong (B-29).
>
> Monitoring dan transfer tetap per hari kalendernya sendiri (`time_check` dan
> `trf_time`), sebab keduanya tidak terikat batch penerimaan mana pun.

**Kolom `start_time` sesungguhnya memuat waktu SELESAI.** Flow menulis `start_time` dari SharePoint ke kolom form "Waktu Penerimaan - Selesai", dan kolom "Mulai" dibiarkan kosong pada seluruh berkas contoh. Ini menguatkan WF-1: memang ada satu waktu penerimaan, bukan dua.

**Tata letak sel, dari berkas contoh.**

| Bagian | Letak |
|---|---|
| Sheet berisi data | `Receiving_Prepast` (A1:P33, landscape, print area A1:P29) dan `Monitoring_Transfer` (A1:Y46) |
| Tanggal form | `C6` pada kedua sheet |
| Baris penerimaan | mulai baris 10, 17 baris tersedia; kolom A no, B supplier, C mulai, D selesai, E kg, F BJ, G TS, H liter, I prepast mulai, J prepast selesai, K flowrate, L temp after heater, M temp output, N silo, O nama |
| Monitoring | 8 kelompok silo (1, 2, 3, 4, 5, 6, 25A, 25B) x 3 kolom (jam, suhu, pH) mulai kolom B; baris 10-16 untuk 7 slot "4 jam I" sampai "4 jam VII"; baris 18 nama operator |
| Transfer | 3 baris per silo mulai baris 21, tiap baris 7 kelompok (jam, batch, volume) mulai kolom D, sehingga 21 transfer per silo |
| Catatan kaki | `A27` sheet 1: "*) Setting Temp. : 90oC, Min Temp. : 81oC" - sumber ambang OPRP 81 C |
| Kolom belum terpakai | `B20` "Jumlah Awal (lt)" - saldo awal, ditunda ke L-1 (D-15) |


### FR-27 Dashboard Analitik

**Modul baru.** Aplikasi Power Apps hanya menampilkan keadaan **saat ini** (volume, pH/suhu terakhir, standing time berjalan). Tidak ada satu pun tampilan yang memperlihatkan tren, pola, atau penyimpangan lintas waktu — padahal seluruh datanya sudah tersimpan sejak awal.

Spesifikasi visual lengkap tiap grafik ada di **Lampiran D**.

#### FR-27.1 Prinsip

| ID | Requirement | Prioritas |
|---|---|---|
| FR-27.1.1 | Dashboard menjawab pertanyaan operasional, bukan sekadar memajang grafik. Setiap panel wajib punya pertanyaan yang dijawabnya — panel tanpa pertanyaan dihapus. | P0 |
| FR-27.1.2 | Susunan mengikuti urutan mendesak: **keadaan sekarang → hal yang perlu ditindak → tren → rincian**. Yang menuntut tindakan hari ini berada di atas. | P0 |
| FR-27.1.3 | Rentang waktu dapat dipilih (hari ini · 7 hari · 30 hari · bulan berjalan · rentang bebas), berlaku serentak ke seluruh panel | P0 |
| FR-27.1.4 | Setiap grafik memiliki **tampilan tabel** yang setara, dapat dibuka dari grafiknya | P0 |
| FR-27.1.5 | Agregasi dihitung di MySQL, bukan di klien | P0 |
| FR-27.1.6 | Setiap panel dapat diekspor sebagai PNG dan CSV | P1 |

#### FR-27.2 Baris Ringkasan

| ID | Panel | Bentuk | Menjawab |
|---|---|---|---|
| FR-27.2.1 | Total penerimaan periode | Angka utama + delta + sparkline | "Berapa susu masuk?" |
| FR-27.2.2 | Total pemakaian produksi | Stat tile + delta | "Berapa yang terpakai?" |
| FR-27.2.3 | Saldo tersimpan di silo | Stat tile | "Berapa yang masih tersimpan?" |
| FR-27.2.4 | Utilisasi kapasitas | Meter (%) | "Seberapa penuh pabrik?" |
| FR-27.2.5 | Rata-rata TS periode | Stat tile + delta | "Bagaimana mutu masuknya?" |

#### FR-27.3 Panel Perhatian — yang menuntut tindakan

Panel ini adalah bagian paling berguna dari dashboard, dan yang paling tidak ada di aplikasi lama.

| ID | Panel | Aturan | Prioritas |
|---|---|---|---|
| FR-27.3.1 | **Silo lewat jadwal cek** | `now − time_check terakhir > monitoring_interval_jam` | P0 |
| FR-27.3.2 | **Standing time melewati ambang** | Diurutkan menurun; ambang dapat disunting per silo | P0 |
| FR-27.3.3 | **Penyimpangan OPRP** | `temp_after_heater < 81 °C` — titik kendali keamanan pangan (lihat C.3) | P0 |
| FR-27.3.4 | **pH di luar rentang** | Di luar 6,0–7,0 | P0 |
| FR-27.3.5 | **Draft belum lengkap** | `is_gantung` / waktu kosong (BR-23) | P0 |
| FR-27.3.6 | **Menunggu approval** | Jumlah per modul, dengan usia tertua | P0 |
| FR-27.3.7 | Setiap baris dapat diklik menuju record atau modul terkait | P0 |
| FR-27.3.8 | Panel yang kosong ditampilkan sebagai keadaan bersih, bukan disembunyikan — ketiadaan peringatan adalah informasi | P1 |

#### FR-27.4 Grafik

| ID | Panel | Bentuk | Menjawab |
|---|---|---|---|
| FR-27.4.1 | **Neraca harian** — masuk vs keluar | Garis 2 seri, satu sumbu (satuan sama) | "Apakah pemakaian mengimbangi penerimaan?" |
| FR-27.4.2 | **Pola jam kedatangan** | Heatmap jam × hari | "Kapan truk menumpuk?" |
| FR-27.4.3 | **Aktivitas per silo** | Batang bertumpuk horizontal — Prepast masuk vs Transfer keluar | "Silo mana yang paling sibuk?" |
| FR-27.4.4 | **Suhu simpan per silo** | Garis, satu seri per silo terpilih + pita rentang aman | "Adakah silo yang menghangat?" |
| FR-27.4.5 | **pH per silo** | Garis terpisah dari suhu — skala berbeda | "Adakah tanda pengasaman?" |
| FR-27.4.6 | **Temp After Heater (OPRP)** | Garis + garis ambang 81 °C, titik di bawah ambang bertanda kritis | "Adakah pelanggaran OPRP?" |
| FR-27.4.7 | **Temp Output Produk** | Grafik terpisah — rentang nilainya berbeda jauh dari FR-27.4.6 | "Apakah pendinginan konsisten?" |
| FR-27.4.8 | **TS per supplier** | Batang terurut + penanda rata-rata | "Supplier mana yang mutunya di bawah?" |
| FR-27.4.9 | **Volume per supplier** | Batang terurut, 8 teratas + "Lainnya" | "Siapa pemasok terbesar?" |
| FR-27.4.10 | **Sebaran standing time** | Batang horizontal per silo + zona ambang | "Berapa lama susu berdiri?" |
| FR-27.4.11 | **Tujuan transfer** | Batang bertumpuk — CMD1 · CMD2 · Pindah Silo | "Ke mana susu mengalir?" |
| FR-27.4.12 | **Waktu tunggu approval** | Batang per modul — usia rata-rata antrean | "Adakah kemacetan persetujuan?" |

#### FR-27.5 Aturan Visual

| ID | Requirement | Prioritas |
|---|---|---|
| FR-27.5.1 | **Tidak pernah dua sumbu-Y.** Dua besaran berbeda skala menjadi dua grafik. | P0 |
| FR-27.5.2 | Warna seri mengikuti entitas, bukan peringkat — filter yang mengubah jumlah seri tidak mengecat ulang sisanya | P0 |
| FR-27.5.3 | Palet kategorikal dipakai berurutan, tidak pernah diputar. Lebih dari 8 kategori dilipat menjadi "Lainnya" | P0 |
| FR-27.5.4 | Warna status (baik/waspada/serius/kritis) hanya untuk keadaan, tidak pernah menjadi warna seri, dan selalu disertai ikon + label | P0 |
| FR-27.5.5 | Mode gelap dipilih tersendiri dari ramp yang sama, bukan pembalikan otomatis | P0 |
| FR-27.5.6 | Palet wajib lolos validasi keterbacaan buta warna sebelum rilis (lihat D.2) | P0 |
| FR-27.5.7 | Seluruh grafik memiliki tooltip; garis memakai crosshair | P0 |

**Catatan implementasi (FR-27, selesai 26 Ags 2026).**
`server/src/services/analitik.js`, `routes/analitik.js`,
`client/src/components/grafik.jsx`, `client/src/pages/Analitik.jsx`.

**Grafik digambar sendiri sebagai SVG, tanpa pustaka grafik.** Dua alasan, dan
keduanya bukan penghematan. Pertama, sistem dipasang on-prem dan tidak boleh
bergantung pada jaringan luar pada jalur kritisnya; satu pustaka grafik berarti
satu dependensi besar lagi yang harus ikut dibawa, diperbarui, dan diaudit.
Kedua, FR-27.5 menuntut aturan warna yang ketat, sedangkan pustaka umumnya
memutar paletnya sendiri, dan melawan perilaku itu biasanya lebih rumit
daripada menggambar sumbu sendiri.

Palet yang dipakai **Okabe-Ito**, dipilih karena memang dirancang agar
terbedakan pada ketiga jenis buta warna yang umum (FR-27.5.6). Warna diberikan
menurut KUNCI ENTITAS lewat peta yang hidup selama halaman terbuka
(FR-27.5.2), sehingga menyaring satu silo tidak mengecat ulang silo lainnya.
Warna status hanya untuk keadaan, tidak pernah menjadi warna seri, dan selalu
disertai label pada legendanya (FR-27.5.4).

**Seluruh agregasi di MySQL** (FR-27.1.5). Satu permintaan mengembalikan
ringkasan, panel perhatian, dan dua belas grafik sekaligus. Menyatukannya bukan
sekadar soal jumlah permintaan: panel yang diambil terpisah beberapa detik
berjauhan dapat menampilkan angka ringkasan dari sebelum sebuah transfer dan
grafik dari sesudahnya, dan pembacanya tidak akan tahu.

**Bug yang ditangkap pengujian.** Kolom `DATE(...)` dikembalikan mysql2 sebagai
objek Date, sehingga label sumbu-X akan tampil sebagai
"Mon Aug 10 2026 07:00:00 GMT+0700". Diperbaiki dengan `DATE_FORMAT` di SQL
agar yang keluar memang teks tanggal, tanpa bergantung pada perilaku driver.
Satu cacat lain terlihat saat diperiksa di layar: label tik sumbu-Y dibulatkan,
sehingga langkah 2,5 tampil sebagai 80-83-85-88-90 dan terbaca sebagai jarak
tik yang tidak rata.

**Panel yang bersih tetap ditampilkan** (FR-27.3.8) sebagai lencana "bersih"
beserta kalimat yang menyatakan apa yang diperiksa. Panel yang menghilang saat
tidak ada temuan membuat pembacanya tidak tahu apakah pemeriksaannya berjalan.

**Delta dibandingkan dengan periode sepanjang yang sama** tepat sebelum periode
berjalan, bukan dengan "bulan lalu" yang panjangnya berbeda. Saldo dan
utilisasi sengaja TIDAK mengikuti rentang: "berapa yang masih tersimpan" tidak
punya arti untuk rentang masa lalu.

**Belum dikerjakan.** FR-27.1.6 (export tiap panel sebagai PNG dan CSV, P1)
belum ada; tampilan tabel tiap panel sudah tersedia dan dapat disalin.
FR-27.3.2 menyebut ambang standing time yang dapat disunting per silo -
ambangnya kini masih tetap di 24 dan 48 jam, sedangkan kolom penyuntingnya
belum ada di master silo.

---

### FR-28 Pratinjau Form GMP Sebelum Export

Saat ini operator menekan Export lalu menunggu, dan baru mengetahui hasilnya setelah membuka file. Bila ada yang salah — record tertinggal, draft belum lengkap, jam kosong — kesalahan itu **baru ketahuan setelah form dicetak dan ditandatangani**.

| ID | Requirement | Prioritas |
|---|---|---|
| FR-28.1 | Layar Export menampilkan **pratinjau form GMP** persis seperti hasil akhirnya: kop dokumen, nomor & revisi, tata letak dua halaman, blok tanda tangan | P0 |
| FR-28.2 | Pratinjau tampil **sebelum** file dihasilkan, dan dapat ditinjau tanpa mengunduh apa pun | P0 |
| FR-28.3 | **Panel validasi** di samping pratinjau menandai masalah sebelum export: baris melebihi kapasitas halaman, record draft, jam kosong, penyimpangan OPRP, record menunggu approval, batch tak sesuai BR-21, **record dengan permintaan koreksi yang masih menunggu** (D-18) | P0 |
| FR-28.4 | Setiap temuan validasi dapat diklik menuju sel yang bersangkutan di pratinjau, dan menuju record aslinya untuk diperbaiki | P0 |
| FR-28.5 | Temuan dibedakan **pemblokir** (melebihi kapasitas halaman) dan **peringatan** (record masih pending) — peringatan tidak menghalangi export | P0 |
| FR-28.6 | Navigasi Halaman 1 / Halaman 2, dan navigasi antar tanggal untuk rentang lebih dari sehari | P0 |
| FR-28.7 | Pratinjau dihasilkan dari **sumber yang sama** dengan file akhir — satu definisi tata letak, dua penyaji (HTML dan Excel). Tidak boleh ada dua implementasi yang bisa saling menyimpang. | P0 |
| FR-28.8 | Cetak langsung dari pratinjau menghasilkan keluaran yang setara dengan mencetak file Excel-nya | P1 |

> **Permintaan koreksi yang menunggu adalah peringatan, bukan pemblokir (D-18).** Record yang sedang diperkarakan operator tetap berstatus `Approved`, jadi tetap terbit di form dengan nilai lamanya. Itu memang tujuan WF-3: lebih baik terbit dengan nilai yang sedang ditinjau daripada hilang dari form sama sekali. Konsekuensinya form dapat memuat angka yang seseorang sudah resmi tandai salah, dan itu tidak boleh terjadi tanpa sepengetahuan Admin. Karena itu barisnya ditandai di pratinjau beserta nilai yang diusulkan, dan temuannya dapat diklik menuju permintaannya (FR-28.4).

> **FR-28.7 adalah syarat arsitektural, bukan sekadar preferensi.** Pratinjau yang dibangun terpisah dari generator Excel pasti akan menyimpang seiring waktu, dan pratinjau yang berbohong lebih berbahaya daripada tidak ada pratinjau sama sekali. Tata letak didefinisikan satu kali sebagai struktur data (baris, kolom, merge, format), lalu dirender oleh dua penyaji.
**Catatan implementasi (F3-2 & F3-3, selesai 25 Ags 2026).**

| Berkas | Peran |
|---|---|
| `db/templates/CMD1_FRM_PRD_01_rev02.xlsx` | Template biner, diturunkan dari hasil export sungguhan |
| `server/src/db/buatTemplateForm.js` | Membangun template itu; dijalankan sekali, dapat diulang |
| `server/src/services/formLayout.js` | Tata letak sebagai struktur data. Satu sumber, dua penyaji |
| `server/src/services/formData.js` | Model data satu hari, beserta validasinya |
| `server/src/services/formExcel.js` | Penyaji xlsx |
| `server/src/routes/export.js` | `preview`, `validate`, `download` |
| `client/src/pages/Export.jsx` | Pratinjau form, panel validasi, unduhan |

**Templatenya diturunkan, bukan digambar ulang.** Template asli tidak tersedia:
paket Power Automate hanya memuat definisi flow, dan Office Script yang menulis
selnya pun tidak ikut, hanya `scriptId`-nya. Yang ada 20 berkas hasil export.
Karena itu templatenya dibuat dari salah satu hasil export dengan barisnya
dibersihkan. Ini pilihan sadar: merge, lebar kolom, tinggi baris, garis, dan
pengaturan cetak adalah bagian dari dokumen `CMD1/FRM/PRD/01` yang disahkan,
bukan hiasan. Menggambar ulang berarti berharap mirip. Kesetiaannya diperiksa
terhadap berkas asalnya: 28 dan 51 rentang merge, seluruh lebar kolom, print
area, orientasi, kop, dan catatan kaki OPRP identik.

**Dua bug ditemukan saat mengerjakannya, keduanya oleh pengujian.**

1. **Volume 9.000 liter tercetak sebagai tanggal di tahun 1924.** ExcelJS
   menyimpan gaya sel sebagai objek BERSAMA antar sel yang gayanya identik;
   menetapkan `numFmt` mengubah objek itu di tempat. Menulis format jam pada
   kolom "Jam Transfer" karena itu membuat kolom "Volume" di sebelahnya ikut
   berformat jam. Perbaikannya menyalin gaya sel sebelum diubah, dan
   menetapkan format SELALU, termasuk `General`, sehingga tidak ada sel yang
   mewarisi format dari gaya yang kebetulan ada di template.
2. **Aturan tanggal patokan tidak dapat disimpulkan dari flow lama.** Flow
   memprefilter prepast tiga hari, yang mudah terbaca sebagai aturan bisnis.
   Pemilik proses menegaskan sebaliknya: patokannya waktu selesai penerimaan,
   dan prepast mengikuti batch induknya. Enam uji integrasi mengikat aturan
   itu, termasuk kasus penerimaan 23.30 yang diprepast 01.00 hari berikutnya.

**Yang diperbaiki dan sudah terikat uji.** B-16 (tanggal dan jam ditulis
sebagai NILAI, bukan teks, sehingga tidak dapat ditafsirkan ulang), B-23
(pemakaian saja yang masuk blok pemakaian; pindah silo masuk catatan), B-24
(dedupe silo), B-27 (hari tanpa penerimaan tetapi ada monitoring atau transfer
kini dianggap berisi), B-28 (dua sheet, bukan enam), B-29 (prepast tidak lagi
diprefilter tanggal).

**Satu temuan dicabut.** B-26 menyebut slot `0 / 0 / 0` sebagai angka nol yang
bukan data, dan itu salah: nolnya penanda silo kosong. Perilakunya kini
dipertahankan, diterbitkan dari `vol_akt_silo_ltr`, dan diikat lima uji
termasuk kasus penanda yang duduk di tengah urutan.

**Catatan implementasi (F3-8, selesai 25 Ags 2026).** `server/src/services/formZip.js`
membangun arsip untuk satu rentang, dengan `_indeks.csv` di dalamnya. Satu
berkas per hari DIPERTAHANKAN di dalam arsipnya, bukan digabung menjadi satu
workbook berisi banyak sheet: `CMD1/FRM/PRD/01` adalah form harian yang
ditandatangani per hari, dan menggabung tiga puluh hari mengubah dokumen
terkendali menjadi laporan. Yang digabung hanya cara mengantarkannya.

Hari yang dilewati tetap tercatat di indeks beserta alasannya, dan itu
disengaja: arsip yang hanya memuat hari berisi membuat penerimanya harus
menebak apakah suatu tanggal memang tidak ada datanya atau exportnya gagal.
Pemblokir pada SATU hari melewati hari itu saja, tidak menghentikan rentangnya,
sebab menghentikan sebulan karena satu hari akan memaksa Admin mengunduh sisanya
satu per satu. `jszip` yang sebelumnya hanya dependensi transitif exceljs kini
dideklarasikan eksplisit; bergantung pada dependensi milik paket lain berarti ia
dapat hilang tanpa peringatan saat paket itu diperbarui.

**Belum dikerjakan.** Notifikasi email (FR-12.4) belum ada; unduhan langsung
memang jalur utamanya. Kolom "Jumlah Awal (lt)" tetap kosong sampai L-1
dikerjakan (D-15).


---

### FR-29 Input Prepast Multi-Silo

Dikonfirmasi pada D-11: satu penerimaan kerap diprepast ke lebih dari satu silo, dan seluruh variabel prosesnya identik — hanya silo tujuan dan volumenya yang berbeda.

Aplikasi sekarang memaksa operator **mengisi form yang sama berulang kali**, satu kali per silo, mengetik ulang jam mulai, jam selesai, flowrate, dan kedua suhu di tiap pengulangan. Itulah sumber anomali `SILO25A/25A` (B-18) dan sumber risiko nilai yang tidak konsisten antar pecahan.

| ID | Requirement | Prioritas |
|---|---|---|
| FR-29.1 | Form Prepast menerima **beberapa silo tujuan dalam satu kali input**, masing-masing dengan volumenya sendiri | P0 |
| FR-29.2 | Variabel proses (jam mulai, jam selesai, flowrate, temp after heater, temp output, remarks) diisi **satu kali** dan berlaku untuk seluruh baris silo | P0 |
| FR-29.3 | Sisa volume berjalan ditampilkan langsung: `sisa batch − total teralokasi`. Tombol simpan terkunci selama sisanya negatif | P0 |
| FR-29.4 | Tombol **"Sisakan ke baris ini"** mengisi baris terakhir dengan seluruh sisa — kasus paling umum, satu ketukan | P0 |
| FR-29.5 | Silo yang sudah dipilih tidak muncul lagi di baris berikutnya — `SILO25A/25A` menjadi mustahil (memperbaiki B-18) | P0 |
| FR-29.6 | Simpan menghasilkan N record prepast dalam **satu transaksi**; bila satu gagal, tidak ada yang tersimpan | P0 |
| FR-29.7 | Volume per baris tidak boleh melebihi kapasitas tersisa silo tujuannya masing-masing | P0 |
| FR-29.8 | `StandingTimeAnchor` diperbarui untuk setiap silo tujuan yang anchor-nya masih kosong (BR-09, berlaku per baris) | P0 |
| FR-29.9 | Koreksi atas prepast multi-silo menampilkan seluruh barisnya kembali sebagai satu kesatuan, bukan sebagai record terpisah | P1 |

**Rancangan antarmuka:**

```
Batch buffer: RCV-20260825-004 — Setia Kawan — sisa 11.455 L

Waktu mulai   [ 04:50 ]     Flowrate          [ 5,2 ]
Waktu selesai [ 06:13 ]     Temp after heater [ 87,5 ]  ✓ OPRP
                            Temp output       [ 7,0 ]

Silo tujuan                            Volume (L)
┌────────────────────────────────────────────────────────┐
│ SILO 25A   ▾   kapasitas sisa 8.000    [   6.455 ]  ✕  │
│ SILO 25B   ▾   kapasitas sisa 12.000   [   5.000 ]  ✕  │
│ + Tambah silo                        [Sisakan ke baris] │
└────────────────────────────────────────────────────────┘
                              Teralokasi 11.455 / 11.455 ✓

                                          [ Simpan ]
```

Satu kali isi menggantikan dua kali isi, dan konsistensi nilai antar pecahan menjadi terjamin secara struktural — bukan bergantung pada ketelitian operator mengetik ulang angka yang sama.

---

### FR-30 Pola Efisiensi Input Lain

FR-29 memperbaiki satu bentuk pengulangan. Menelusuri seluruh alur input, ditemukan lima lagi yang berpola serupa — pekerjaan berulang yang timbul dari keterbatasan form, bukan dari tuntutan proses.

| ID | Pola | Sekarang | Usulan | Prioritas |
|---|---|---|---|---|
| FR-30.1 | **Monitoring beberapa silo sekaligus** | Satu silo per kunjungan form; operator memeriksa 8 silo dalam satu ronde berarti 8 kali isi form | Satu form ronde: daftar silo dengan kolom pH & suhu, satu waktu cek berlaku bersama. Satu transaksi. | P0 |
| FR-30.2 | **Transfer berurutan dari silo sama** | Tiap transfer mengulang pilih silo → hitung FIFO → isi | Setelah simpan, tawarkan "Transfer lagi dari silo ini" dengan FIFO sudah dihitung ulang | P1 |
| FR-30.3 | **Nomor batch berurutan** | Diketik manual tiap kali (sumber B-20) | Nomor berikutnya disarankan otomatis dari batch terakhir dengan prefiks sama; operator hanya mengonfirmasi | P0 |
| FR-30.4 | **Prefill waktu berantai** | Sebagian sudah ada — jam mulai prepast terisi dari finish penerimaan | Diperluas dan dikonsistenkan: jam mulai prepast berikutnya = jam selesai prepast sebelumnya di jalur yang sama | P1 |
| FR-30.5 | **Nilai berulang antar hari** | Flowrate dan suhu diketik ulang tiap batch meski nilainya nyaris tetap | Nilai terakhir ditawarkan sebagai default yang dapat ditimpa, ditandai jelas sebagai saran | P2 |
| FR-30.6 | **Stock opname bulanan** | Seluruh silo diisi dari nol tiap periode | Tawarkan volume aktual sistem sebagai nilai awal — operator mengoreksi selisihnya, tidak mengetik dari kosong | P1 |
| FR-30.7 | **Batch transfer multi-baris** | Batch yang sama diketik ulang pada setiap transfer tambahan | Operator memilih `Batch sama` untuk mengisi prefiks + nomor sekali bagi seluruh tank beraturan `PILIH`, atau `Manual per transfer` untuk mengisi batch berbeda pada tiap baris. Aturan `CMD2`, tanpa batch, dan pindah silo tetap ditentukan sistem. | P1 |

**FR-30.1 patut didahulukan.** Monitoring adalah aktivitas paling sering di seluruh sistem — 8 silo × 7 kali cek sehari berarti sampai 56 kali pengisian form per hari, masing-masing mengulang pemilihan silo dan penulisan waktu. Menggabungkannya menjadi satu form ronde memangkas beban itu menjadi 7 kali.

> **Prinsip di balik FR-29 dan FR-30:** bila operator mengetik nilai yang sama dua kali, itu adalah cacat rancangan form — bukan ketelitian yang perlu dituntut. Setiap pengulangan adalah peluang munculnya ketidakcocokan data.

---

### FR-26 Manajemen Master Data

**Modul baru — tidak ada padanannya di aplikasi Power Apps.**

Ini bukan penambahan cakupan, melainkan **penggantian kemampuan yang selama ini disediakan platform secara cuma-cuma**. Selama aplikasi bertumpu pada SharePoint, seluruh master data (silo, supplier, operator) dapat disunting langsung lewat antarmuka SharePoint List tanpa perlu membangun apa pun. Begitu data berpindah ke MySQL, antarmuka itu hilang — dan tanpa penggantinya, setiap penambahan supplier atau perubahan kapasitas silo akan menuntut intervensi DBA.

#### FR-26.1 Halaman yang Disediakan

Seluruh master data memiliki halamannya sendiri di bawah `/admin/master/`, dengan pola yang seragam: daftar dapat dicari & disaring · buat · sunting · aktif/nonaktif · riwayat perubahan.

| ID | Halaman | Route | Field yang dikelola |
|---|---|---|---|
| FR-26.1.1 | **Manajemen User** | `/admin/master/users` | Nama lengkap, kode/NIK, peran (Operator · SPV · Admin), status aktif, reset PIN |
| FR-26.1.2 | **Manajemen Supplier** | `/admin/master/suppliers` | Nama supplier, kode, status aktif |
| FR-26.1.3 | **Manajemen Silo** | `/admin/master/silos` | Nama, kode, QR, kapasitas maksimum, ambang interval monitoring, status aktif, status tersedia, catatan |
| FR-26.1.4 | **Manajemen Tank** | `/admin/master/tanks` | Nama tank, QR, nilai transfer, tujuan CMD, status aktif |
| FR-26.1.5 | **Manajemen Prefiks Batch** | `/admin/master/batch-prefixes` | Kode, label, penanda baku, status aktif, urutan tampil |
| FR-26.1.6 | **Manajemen Template Form** | `/admin/master/form-templates` | Nomor dokumen, revisi, masa berlaku, judul, catatan kaki |
| FR-26.1.7 | **Ringkasan Master Data** | `/admin/master` | Beranda: jumlah entri per master, entri nonaktif, perubahan terakhir |

#### FR-26.2 Ketentuan Umum

| ID | Requirement | Prioritas |
|---|---|---|
| FR-26.2.1 | Master data yang sudah pernah dipakai transaksi **tidak dapat dihapus**, hanya dinonaktifkan. Penonaktifan menyembunyikannya dari pilihan input tanpa memengaruhi data historis. | P0 |
| FR-26.2.2 | Seluruh perubahan master data tercatat di `audit_log` dengan nilai sebelum & sesudah | P0 |
| FR-26.2.3 | Setiap halaman menampilkan **riwayat perubahan** per entri, dapat dibuka dari barisnya | P0 |
| FR-26.2.4 | Ambang interval monitoring per silo dapat disunting — **menggantikan pencocokan string `"SILO 25A"` yang menjadi akar B-19** | P0 |
| FR-26.2.5 | Reset PIN menghasilkan PIN sementara yang **wajib diganti saat login berikutnya**; PIN lama tidak pernah dapat dilihat siapa pun, termasuk Admin | P0 |
| FR-26.2.6 | Penurunan kapasitas silo di bawah volume yang sedang tersimpan ditolak, disertai penjelasan | P0 |
| FR-26.2.7 | Perubahan peran user berlaku pada sesi berikutnya; sesi berjalan diberi tahu | P1 |
| FR-26.2.8 | Setiap master dapat diekspor ke CSV | P1 |
| FR-26.2.9 | Pencarian & filter status pada setiap halaman daftar | P0 |

**Akses:** terbatas untuk peran Admin (BR-22). Ini sekaligus memberi `varIsAdmin` alasan keberadaan yang selama ini tidak ada.

**Dampak jadwal:** menambah sekitar 2 minggu. Detail penempatannya di Bagian 12.4.

**Catatan implementasi (F3-b, selesai 25 Ags 2026).**
`server/src/services/masterData.js`, `routes/master.js`, `client/src/pages/Master.jsx`.

**Satu mesin, bukan tujuh halaman.** Perbedaan antar master hanya pada kolom
dan beberapa aturannya. Yang berbeda dinyatakan sebagai data di `MASTER`, yang
sama dikerjakan sekali; daftar, cari, audit, keunikan, dan penonaktifan tidak
disalin tujuh kali. Antarmukanya pun tidak tahu kolom apa yang dimiliki tiap
master: bentuknya datang dari server bersama datanya, dari definisi yang sama
yang dipakai validasi. Menambah supplier baru karena itu tidak menuntut
perubahan di dua tempat.

**Tidak ada penghapusan sama sekali**, hanya penonaktifan (FR-26.2.1).
Menghapus supplier akan membuat baris form lama kehilangan nama pemasoknya.
Jumlah transaksi yang merujuk tiap entri ditampilkan di daftarnya, supaya
dampaknya terlihat sebelum dinonaktifkan, bukan sesudah.

**Penjaga yang ditegakkan, masing-masing dengan alasannya.**

| Penjaga | Alasan |
|---|---|
| Kapasitas silo tidak boleh turun di bawah isinya (FR-26.2.6) | Angka kapasitas yang lebih kecil daripada isinya adalah angka yang berbohong. Batasnya nominal + toleransi (BR-24), bukan nominal saja |
| Silo berisi tidak dapat dinonaktifkan | Volumenya akan hilang dari dashboard tanpa pernah keluar dari silo |
| Admin tidak dapat menonaktifkan akunnya sendiri | Tidak ada yang dapat memulihkannya dari dalam |
| Admin terakhir tidak dapat diturunkan atau dinonaktifkan | Master data akan menjadi tidak dapat dikelola siapa pun |
| `is_buffer` tidak dapat disunting | BR-02 menggantungkan seluruh alur penerimaan padanya; mengubahnya lewat layar master akan memindahkan tujuan penerimaan tanpa ada yang menyadarinya |

**FR-26.2.4 menutup B-19 pada akarnya.** Ambang interval monitoring kini kolom
`silo.monitoring_interval_jam` yang dapat disunting per silo, bukan hasil
pencocokan string `"SILO 25A"` yang tidak pernah cocok karena nama
sesungguhnya `SILO25A` tanpa spasi.

**PIN tidak pernah ditentukan Admin (FR-26.2.5).** Baik saat membuat user baru
maupun saat reset, sistem membangkitkan PIN sementara, menampilkannya SEKALI di
respons, dan menandai wajib ganti saat login berikutnya. PIN tidak pernah masuk
tabel mana pun selain sebagai hash argon2id, **termasuk tidak masuk jejak
audit** - jejak audit justru tempat yang paling banyak dibaca saat diaudit, dan
PIN di sana akan membuat tanda tangan elektronik seseorang dapat dipakai orang
lain. Yang dicatat adalah peristiwanya, bukan nilainya. Reset PIN sekaligus
membuka kunci akun yang sedang terkunci karena salah PIN berulang.

**Jejak audit mencatat hanya kolom yang BERUBAH.** Menyalin seluruh baris
membuat perubahan satu kolom tenggelam di antara belasan kolom yang sama persis.

**Belum dikerjakan.** FR-26.2.7 baru berupa pemberitahuan bahwa perubahan peran
berlaku pada sesi berikutnya; sesi berjalan tidak dipaksa menyegarkan
wewenangnya. Master `form-templates` sudah dapat dikelola, tetapi penyaji form
belum membacanya - tata letak masih dipilih dari definisi di `formLayout.js`
(FR-12.7 belum tersambung).

---

## 6. Katalog Business Rule

Aturan-aturan berikut adalah inti sistem. Implementasi harus mereplikasinya persis dan menutupinya dengan unit test.

| ID | Aturan |
|---|---|
| **BR-01** | Volume silo adalah nilai turunan, tidak pernah disimpan. Buffer menjumlahkan sisa Receiving; silo penyimpanan menjumlahkan sisa Prepast. Keduanya menyaring `status_fifo='ACTIVE'` DAN `status_approval NOT IN ('Rejected','REVISED','VOIDED')`. |
| **BR-02** | Penerimaan selalu masuk ke buffer `000`. Susu hanya berpindah ke silo penyimpanan melalui Prepast. |
| **BR-03** | Konversi kg → liter: `FLOOR(qty_kg / berat_jenis)`. Selalu dibulatkan ke bawah. |
| **BR-04** | Antrean prepast diurutkan waktu penerimaan menaik; alokasi transfer diurutkan `prepast_finish` menaik. Keduanya FIFO ketat. |
| **BR-05** | Alokasi transfer harus tuntas — bila sisa yang belum teralokasi > 0, submit ditolak. |
| **BR-06** | Volume prepast tidak boleh melebihi sisa batch induk. |
| **BR-07** | Volume transfer tidak boleh melebihi volume aktual silo. |
| **BR-08** | Batch tertutup (`status_fifo='CLOSED'`) saat sisanya mencapai nol dan tidak dapat dialokasikan lagi. |
| **BR-09** | `StandingTimeAnchor` di-set saat susu masuk silo kosong, dihapus saat silo dikosongkan, diwariskan pada pindah-silo penuh, dan diperbarui ke `Now()` pada pindah-silo sebagian. Hanya ditulis bila anchor tujuan masih kosong. |
| **BR-10** | Ambang interval monitoring: 2 jam untuk SILO 25A & 25B, 4 jam untuk silo lain. Ambang disimpan sebagai kolom `silo.monitoring_interval_jam`, **tidak pernah sebagai perbandingan nama silo** — lihat B-19. |
| **BR-11** | Rollover tengah malam berlaku pada prepast (finish sebelum start → +1 hari) dan transfer (waktu transfer sebelum anchor → +1 hari). |
| **BR-12** | Koreksi tidak pernah mengubah record asli selain menandainya `REVISED`; selalu dibuat record baru dengan `correction_ref` ke record lama. |
| **BR-13** | Void dan koreksi mengembalikan volume ke hulu: prepast → receiving induk; transfer → seluruh prepast sumber sesuai alokasi tercatat. |
| **BR-14** | Void transfer PINDAH SILO juga mem-void record prepast anak yang tercipta di silo tujuan, hanya bila anak tersebut masih utuh (`qty_remaining = vol_prepast`). |
| **BR-15** | Record dengan turunan aktif tidak dapat diedit, di-void, maupun direject. Turunan harus ditangani lebih dulu. |
| **BR-16** | Record GANTUNG adalah satu-satunya yang boleh di-update in-place; pelengkapan tidak melakukan reversal dan tidak membuat record baru. |
| **BR-17** | Transfer ke buffer `000` dilarang. Silo tujuan tidak boleh sama dengan silo asal. |
| **BR-18** | `cmd_destination = 'CMD2'` hanya bila tank tujuan CMD 2; selain itu `CMD1`. |
| **BR-19** | Operator hanya dapat mengedit record `Pending Approval` atau `Rejected`; untuk record `Approved` ia harus mengajukan Request Edit. SPV dapat mengedit record `Approved` secara langsung. |
| **BR-20** | Stock opname bersifat unik per (periode, silo) dan menjadi read-only setelah difinalisasi. |
| **BR-25** | **Pengembalian.** Susu yang sudah ditransfer keluar dapat dikembalikan ke silo penyimpanan (tidak pernah ke buffer). Komposisi suppliernya tidak dapat dipulihkan karena sudah tercampur, sehingga volume itu dicatat **tanpa identitas supplier** dan ditampilkan sebagai volume tak tertelusuri pada silo yang menerimanya. Alasan pengembalian wajib diisi. Kunci urutan FIFO diambil dari usia susu (waktu transfer asal, atau waktu keluar yang diisi operator), **bukan** waktu kembali. Silo kosong didahulukan sebagai tujuan; memilih silo berisi diperingatkan tetapi tidak diblokir. |
| **BR-22** | Approve, approve massal, reject, keputusan Request Edit, dan void adalah wewenang **SPV semata** — tidak diwarisi Admin. Stock Opname dan manajemen master data adalah wewenang **Admin semata**. Export terbuka untuk SPV dan Admin. Penegakan dilakukan di server; menyembunyikan tombol bukan mekanisme otorisasi. |
| **BR-23** | Record draft (waktu belum lengkap) tidak dapat diajukan maupun disetujui. Ia harus dilengkapi lebih dulu, dan baru setelah itu masuk antrean approval. |
| **BR-21** | Batch number berbentuk kanonik `<PREFIKS><nomor>` — huruf besar, tanpa spasi, tanpa nol di depan (`HRC1`, `FC2`, `INK13`). Prefiks wajib berasal dari `batch_prefix` yang aktif. Transfer ke tank CMD 2 memakai batch `CMD2`; PINDAH SILO memakai `TF TO <silo>` yang dihasilkan sistem. |

---

## 7. Arsitektur Target

### 7.1 Ringkasan Stack

```
┌──────────────────────────────────────────────────────────┐
│  Klien — React 18 + Vite                                 │
│  react-router · TanStack Query · react-hook-form + zod   │
│  Tailwind + shadcn/ui · html5-qrcode                     │
└────────────────────────┬─────────────────────────────────┘
                         │  REST / JSON, JWT Bearer
┌────────────────────────▼─────────────────────────────────┐
│  Server — Node.js 20 + Express (JavaScript)              │
│  ┌────────────────────────────────────────────────────┐  │
│  │ routes/    validasi request (zod), auth guard      │  │
│  │ services/  BUSINESS RULE — transaksional           │  │
│  │            fifo.js · standingTime.js · reversal.js │  │
│  │ repo/      akses data (mysql2/promise)             │  │
│  └────────────────────────────────────────────────────┘  │
│  exceljs (export) · argon2 (PIN) · pino (log)            │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│  MySQL 8 — InnoDB, REPEATABLE READ                       │
│  Tabel transaksi · master · VIEW volume · tabel audit    │
└──────────────────────────────────────────────────────────┘
```

**Alasan tanpa ORM berat:** seluruh operasi kritis (alokasi FIFO, reversal berjenjang) memerlukan kontrol eksplisit atas locking dan urutan statement. `mysql2/promise` dengan SQL yang ditulis tangan membuat perilaku transaksi terlihat jelas dan mudah di-review. Bila diperlukan query builder ringan, Kysely dapat ditambahkan tanpa mengubah arsitektur.

### 7.2 Struktur Direktori

```
fm-receiving/
├─ client/
│  └─ src/
│     ├─ features/{auth,dashboard,receiving,prepast,transfer,
│     │            monitoring,stock-opname,approval,data-list,
│     │            silo-detail,export}/
│     ├─ components/ui/
│     ├─ lib/{api.js,queryClient.js,format.js}
│     └─ routes.jsx
└─ server/
   └─ src/
      ├─ routes/
      ├─ services/
      │  ├─ fifo.js            ← BR-04, BR-05
      │  ├─ standingTime.js    ← BR-09
      │  ├─ reversal.js        ← BR-12, BR-13, BR-14
      │  ├─ dependency.js      ← BR-15
      │  └─ idGenerator.js     ← M-4
      ├─ repo/
      ├─ db/{pool.js,migrations/,seeds/}
      └─ middleware/{auth.js,rbac.js,errorHandler.js}
```

### 7.3 Aturan Transaksi

Setiap endpoint yang mengubah volume berjalan dalam satu transaksi:

```js
// server/src/services/transfer.js — inti submit transfer
async function submitTransfer(input, user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Kunci baris prepast agar operator lain tidak mengalokasikan volume yang sama.
    // Ini yang tidak mungkin dilakukan Power Apps dan menjadi sumber over-allocation.
    const batches = await conn.query(
      `SELECT * FROM prepast_record
        WHERE silo_tujuan_id = ? AND status_fifo = 'ACTIVE'
          AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
        ORDER BY prepast_finish ASC
        FOR UPDATE`, [input.siloId]);

    const allocation = allocateFifo(batches, input.volume);   // murni, teruji
    if (allocation.unallocated > 0) throw new BusinessError('BR-05');

    const trfId = await nextId(conn, 'TRF');
    await insertTransfer(conn, trfId, input, allocation, user);
    await applyAllocation(conn, allocation);
    await resolveStandingTime(conn, input, allocation);
    if (input.type === 'PINDAH_SILO') await createChildPrepast(conn, trfId, input, allocation);

    await conn.commit();
    return trfId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}
```

`allocateFifo()` adalah fungsi murni tanpa I/O — inilah unit yang harus punya cakupan test paling tinggi, karena satu bug di sini merusak stok secara permanen.

---

## 8. Model Data MySQL

### 8.1 Perubahan Struktural dari SharePoint

| Aspek | SharePoint (sekarang) | MySQL (target) | Alasan |
|---|---|---|---|
| Datetime | `VARCHAR "mm/dd/yyyy hh:mm"` | `DATETIME` | M-3 |
| Alokasi FIFO | JSON string di satu kolom | Tabel `transfer_allocation` | M-6 |
| Relasi | Pencocokan string `Title` | `BIGINT` FK | M-6 |
| Choice field | `Record{Value}` | `ENUM` | Type safety |
| Volume silo | Dihitung ulang di UI | `VIEW v_silo_volume` | M-8 |
| Master tank | Hardcode di `App.OnStart` | Tabel `tank_master` | Maintainability |
| ID | `PREFIX-tanggal-RANDOM` | Sequence + `UNIQUE` | M-4 |

### 8.2 Skema

```sql
-- ============ MASTER ============
CREATE TABLE operator (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode          VARCHAR(20)  NOT NULL UNIQUE,     -- eks Title
  nama_lengkap  VARCHAR(120) NOT NULL,
  pin_hash      VARCHAR(255) NOT NULL,            -- argon2id
  role          ENUM('Operator','SPV','Admin') NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE supplier (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode          VARCHAR(20)  NOT NULL UNIQUE,
  supplier_name VARCHAR(150) NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

CREATE TABLE silo (
  id                   BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                 VARCHAR(20)  NOT NULL UNIQUE,   -- '000','2','25A',...
  silo_name            VARCHAR(80)  NOT NULL,
  qr_code_value        VARCHAR(80)  NOT NULL UNIQUE,
  kapasitas_maks_ltr   DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_buffer            BOOLEAN NOT NULL DEFAULT FALSE, -- kode '000'
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  is_available         BOOLEAN NOT NULL DEFAULT TRUE,
  monitoring_interval_jam TINYINT NOT NULL DEFAULT 4,  -- BR-10, 2 untuk 25A/25B
  standing_time_anchor DATETIME NULL,
  notes                TEXT NULL
) ENGINE=InnoDB;

CREATE TABLE tank_master (
  id              BIGINT PRIMARY KEY AUTO_INCREMENT,
  tank_name       VARCHAR(40) NOT NULL UNIQUE,
  qr_value        VARCHAR(40) NOT NULL UNIQUE,
  tank_trf_value  VARCHAR(40) NOT NULL,
  cmd_destination ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',  -- BR-18
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB;

-- Menggantikan field batch bebas-teks. Prefiks menjadi master data yang
-- dikelola Admin (FR-26.5), bukan konvensi lisan. Lihat BR-21 & B-20.
CREATE TABLE batch_prefix (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode        VARCHAR(10)  NOT NULL UNIQUE,   -- 'HRC','FC','INK','FULLFM','SR'
  label       VARCHAR(80)  NOT NULL,
  is_standar  BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE untuk HRC & FC
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  urutan      SMALLINT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO batch_prefix (kode, label, is_standar, urutan) VALUES
  ('HRC',    'HRC',                 TRUE,  1),
  ('FC',     'FC',                  TRUE,  2),
  ('INK',    'Inkubasi',            FALSE, 3),
  ('FULLFM', 'Full Fresh Milk',     FALSE, 4),
  ('SR',     'SR',                  FALSE, 5);

-- ============ TRANSAKSI ============
CREATE TABLE receiving (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode               VARCHAR(30) NOT NULL UNIQUE,      -- RCV-20260825-001
  supplier_id        BIGINT NOT NULL,
  silo_id            BIGINT NOT NULL,                  -- selalu buffer (BR-02)
  qty_kg             DECIMAL(12,2) NOT NULL,
  berat_jenis        DECIMAL(8,4)  NOT NULL,
  qty_ltr            DECIMAL(12,2) NOT NULL,           -- FLOOR(kg/bj), BR-03
  qty_remaining_ltr  DECIMAL(12,2) NOT NULL,
  nilai_ts           DECIMAL(8,2)  NULL,
  finish_time        DATETIME NOT NULL,
  operator_id        BIGINT NOT NULL,
  status_approval    ENUM('Pending Approval','Approved','Rejected',
                          'Edit Requested','REVISED','VOIDED') NOT NULL
                          DEFAULT 'Pending Approval',
  status_fifo        ENUM('ACTIVE','CLOSED')  NOT NULL DEFAULT 'ACTIVE',
  buffer_status      ENUM('IN_BUFFER','IN_PREPAST','COMPLETED') NOT NULL DEFAULT 'IN_BUFFER',
  cmd_source         ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  correction_ref_id  BIGINT NULL,
  rejection_comment  TEXT NULL,
  approved_by_id     BIGINT NULL,
  approved_at        DATETIME NULL,
  remarks            TEXT NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_rcv_supplier   FOREIGN KEY (supplier_id)       REFERENCES supplier(id),
  CONSTRAINT fk_rcv_silo       FOREIGN KEY (silo_id)           REFERENCES silo(id),
  CONSTRAINT fk_rcv_operator   FOREIGN KEY (operator_id)       REFERENCES operator(id),
  CONSTRAINT fk_rcv_correction FOREIGN KEY (correction_ref_id) REFERENCES receiving(id),
  CONSTRAINT ck_rcv_remaining  CHECK (qty_remaining_ltr >= 0),
  INDEX idx_rcv_fifo (silo_id, status_fifo, status_approval, finish_time),
  INDEX idx_rcv_status (status_approval)
) ENGINE=InnoDB;

CREATE TABLE prepast_record (
  id                 BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode               VARCHAR(30) NOT NULL UNIQUE,      -- PST-20260825-001
  receiving_id       BIGINT NULL,                      -- NULL bila anak PINDAH SILO
  parent_prepast_id  BIGINT NULL,                      -- terisi bila anak PINDAH SILO
  supplier_id        BIGINT NOT NULL,
  silo_tujuan_id     BIGINT NOT NULL,
  vol_prepast_ltr    DECIMAL(12,2) NOT NULL,
  qty_remaining_ltr  DECIMAL(12,2) NOT NULL,
  prepast_start      DATETIME NULL,                    -- NULL bila GANTUNG
  prepast_finish     DATETIME NULL,
  flowrate_pst       DECIMAL(8,2) NULL,
  temp_after_heater  DECIMAL(6,2) NULL,
  temp_output_prd    DECIMAL(6,2) NULL,
  nilai_ts           DECIMAL(8,2) NULL,
  operator_id        BIGINT NOT NULL,
  status_approval    ENUM('Pending Approval','Approved','Rejected',
                          'Edit Requested','REVISED','VOIDED') NOT NULL
                          DEFAULT 'Pending Approval',
  status_fifo        ENUM('ACTIVE','CLOSED') NOT NULL DEFAULT 'ACTIVE',
  cmd_source         ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  is_gantung         BOOLEAN NOT NULL DEFAULT FALSE,
  transfer_ref_id    BIGINT NULL,                      -- transfer yang melahirkannya
  correction_ref_id  BIGINT NULL,
  rejection_comment  TEXT NULL,
  remarks            TEXT NULL,
  approved_by_id     BIGINT NULL,
  approved_at        DATETIME NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_pst_receiving FOREIGN KEY (receiving_id)   REFERENCES receiving(id),
  CONSTRAINT fk_pst_supplier  FOREIGN KEY (supplier_id)    REFERENCES supplier(id),
  CONSTRAINT fk_pst_silo      FOREIGN KEY (silo_tujuan_id) REFERENCES silo(id),
  CONSTRAINT fk_pst_operator  FOREIGN KEY (operator_id)    REFERENCES operator(id),
  CONSTRAINT ck_pst_remaining CHECK (qty_remaining_ltr >= 0
                                     AND qty_remaining_ltr <= vol_prepast_ltr),
  INDEX idx_pst_fifo (silo_tujuan_id, status_fifo, status_approval, prepast_finish),
  INDEX idx_pst_receiving (receiving_id),
  INDEX idx_pst_status (status_approval)
) ENGINE=InnoDB;

CREATE TABLE transfer (
  id                  BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                VARCHAR(30) NOT NULL UNIQUE,     -- TRF-20260825-001
  transfer_type       ENUM('PEMAKAIAN PRODUKSI','PINDAH SILO') NOT NULL,
  silo_asal_id        BIGINT NOT NULL,
  tank_id             BIGINT NULL,                     -- PEMAKAIAN PRODUKSI
  silo_tujuan_id      BIGINT NULL,                     -- PINDAH SILO
  vol_ltr             DECIMAL(12,2) NOT NULL,
  vol_akt_silo_ltr    DECIMAL(12,2) NOT NULL,          -- snapshot saat submit
  batch               VARCHAR(80) NULL,
  trf_time            DATETIME NULL,                   -- NULL bila GANTUNG
  standing_time_menit INT NULL,
  operator_id         BIGINT NOT NULL,
  status_approval     ENUM('Pending Approval','Approved','Rejected',
                           'Edit Requested','REVISED','VOIDED') NOT NULL
                           DEFAULT 'Pending Approval',
  cmd_destination     ENUM('CMD1','CMD2') NOT NULL DEFAULT 'CMD1',
  is_gantung          BOOLEAN NOT NULL DEFAULT FALSE,
  correction_ref_id   BIGINT NULL,
  rejection_comment   TEXT NULL,
  approved_by_id      BIGINT NULL,
  approved_at         DATETIME NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_trf_asal     FOREIGN KEY (silo_asal_id)   REFERENCES silo(id),
  CONSTRAINT fk_trf_tujuan   FOREIGN KEY (silo_tujuan_id) REFERENCES silo(id),
  CONSTRAINT fk_trf_tank     FOREIGN KEY (tank_id)        REFERENCES tank_master(id),
  CONSTRAINT fk_trf_operator FOREIGN KEY (operator_id)    REFERENCES operator(id),
  CONSTRAINT ck_trf_tujuan   CHECK (silo_asal_id <> silo_tujuan_id),   -- BR-17
  INDEX idx_trf_silo (silo_asal_id, trf_time),
  INDEX idx_trf_status (status_approval)
) ENGINE=InnoDB;

-- Menggantikan JSON string `supplier_fifo`. Inilah yang membuat rollback
-- dan pengecekan dependensi menjadi query biasa, bukan substring match.
CREATE TABLE transfer_allocation (
  id             BIGINT PRIMARY KEY AUTO_INCREMENT,
  transfer_id    BIGINT NOT NULL,
  prepast_id     BIGINT NOT NULL,
  supplier_id    BIGINT NOT NULL,
  qty_available  DECIMAL(12,2) NOT NULL,   -- sebelum alokasi
  qty_allocated  DECIMAL(12,2) NOT NULL,
  qty_after      DECIMAL(12,2) NOT NULL,
  urutan_fifo    SMALLINT NOT NULL,
  CONSTRAINT fk_alloc_transfer FOREIGN KEY (transfer_id) REFERENCES transfer(id) ON DELETE CASCADE,
  CONSTRAINT fk_alloc_prepast  FOREIGN KEY (prepast_id)  REFERENCES prepast_record(id),
  CONSTRAINT fk_alloc_supplier FOREIGN KEY (supplier_id) REFERENCES supplier(id),
  CONSTRAINT ck_alloc_positive CHECK (qty_allocated > 0),
  UNIQUE KEY uq_alloc (transfer_id, prepast_id),
  INDEX idx_alloc_prepast (prepast_id)     -- dependency guard BR-15
) ENGINE=InnoDB;

CREATE TABLE monitoring (
  id                      BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode                    VARCHAR(30) NOT NULL UNIQUE,   -- MTR-20260825-001
  silo_id                 BIGINT NOT NULL,
  ph_check                DECIMAL(5,2) NOT NULL,
  temp_check              DECIMAL(6,2) NOT NULL,
  time_check              DATETIME NOT NULL,
  supplier_list           TEXT NULL,                     -- snapshot
  val_aktual_snapshot_ltr DECIMAL(12,2) NULL,
  operator_id             BIGINT NOT NULL,
  status_approval         ENUM('Pending Approval','Approved','Rejected',
                               'Edit Requested','REVISED','VOIDED') NOT NULL
                               DEFAULT 'Pending Approval',
  correction_ref_id       BIGINT NULL,
  rejection_comment       TEXT NULL,
  approved_by_id          BIGINT NULL,
  approved_at             DATETIME NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_mon_silo     FOREIGN KEY (silo_id)     REFERENCES silo(id),
  CONSTRAINT fk_mon_operator FOREIGN KEY (operator_id) REFERENCES operator(id),
  INDEX idx_mon_silo_time (silo_id, time_check DESC),
  INDEX idx_mon_status (status_approval)
) ENGINE=InnoDB;

CREATE TABLE stock_opname (
  id               BIGINT PRIMARY KEY AUTO_INCREMENT,
  periode          CHAR(7) NOT NULL,                     -- 'YYYY-MM'
  silo_id          BIGINT NOT NULL,
  jumlah_awal_ltr  DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_finalized     BOOLEAN NOT NULL DEFAULT FALSE,
  operator_id      BIGINT NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_so_silo     FOREIGN KEY (silo_id)     REFERENCES silo(id),
  CONSTRAINT fk_so_operator FOREIGN KEY (operator_id) REFERENCES operator(id),
  UNIQUE KEY uq_so (periode, silo_id)                   -- BR-20, memperbaiki upsert rusak
) ENGINE=InnoDB;

-- ============ AUDIT ============
-- Tidak ada padanannya di aplikasi lama. Wajib untuk sistem yang volumenya
-- bisa dikoreksi dan di-void oleh manusia.
--
-- Memenuhi 21 CFR Part 11 §11.10(e) dan ALCOA+ — lihat 15.3.1 (syarat A-1..A-8).
-- APPEND-ONLY: user aplikasi hanya diberi INSERT + SELECT pada tabel ini.
--   GRANT SELECT, INSERT ON fmdb.audit_log TO 'fm_app'@'%';
--   (tanpa UPDATE/DELETE — termasuk untuk role Admin aplikasi)
CREATE TABLE audit_log (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  entity      VARCHAR(40) NOT NULL,
  entity_id   BIGINT NOT NULL,
  action      ENUM('CREATE','UPDATE','APPROVE','REJECT','VOID','CORRECT',
                   'COMPLETE_DRAFT','REQUEST_EDIT','GRANT_EDIT','DENY_EDIT',
                   'FINALIZE_SO','LOGIN_FAILED') NOT NULL,
  actor_id    BIGINT NOT NULL,           -- A-3: FK, bukan string nama bebas
  before_json JSON NULL,                 -- A-2: snapshot baris UTUH, bukan delta
  after_json  JSON NULL,
  reason      TEXT NULL,                 -- A-5: wajib untuk CORRECT & VOID (ditegakkan di service)
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- A-4: waktu server (UTC)
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES operator(id),
  INDEX idx_audit_entity (entity, entity_id, created_at),
  INDEX idx_audit_actor (actor_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE id_sequence (
  prefix      CHAR(3) NOT NULL,
  tanggal     DATE    NOT NULL,
  last_number INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (prefix, tanggal)
) ENGINE=InnoDB;
```

### 8.3 VIEW Volume — Menggantikan 30+ Salinan Formula

```sql
CREATE OR REPLACE VIEW v_silo_volume AS
SELECT
  s.id                     AS silo_id,
  s.kode,
  s.silo_name,
  s.kapasitas_maks_ltr,
  s.standing_time_anchor,
  COALESCE(v.vol_aktual_ltr, 0) AS vol_aktual_ltr,
  COALESCE(v.jumlah_batch,   0) AS jumlah_batch_aktif,
  CASE WHEN s.kapasitas_maks_ltr > 0
       THEN ROUND(COALESCE(v.vol_aktual_ltr,0) / s.kapasitas_maks_ltr * 100, 0)
       ELSE 0 END          AS persen_isi
FROM silo s
LEFT JOIN (
  -- Buffer: dihitung dari sisa receiving (BR-01)
  SELECT silo_id, SUM(qty_remaining_ltr) AS vol_aktual_ltr, COUNT(*) AS jumlah_batch
  FROM receiving
  WHERE status_fifo = 'ACTIVE'
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_id
  UNION ALL
  -- Silo penyimpanan: dihitung dari sisa prepast (BR-01)
  SELECT silo_tujuan_id, SUM(qty_remaining_ltr), COUNT(*)
  FROM prepast_record
  WHERE status_fifo = 'ACTIVE'
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_tujuan_id
) v ON v.silo_id = s.id
WHERE s.is_active = TRUE;
```

Karena buffer hanya menerima receiving dan silo penyimpanan hanya menerima prepast, kedua cabang UNION tidak pernah bertumpuk pada `silo_id` yang sama.

Satu VIEW pendamping menyediakan status monitoring per silo (`v_silo_monitoring_status`), menggabungkan pengecekan terakhir dengan `monitoring_interval_jam` untuk menghasilkan label FR-2.3 di server, bukan di komponen React.

---

## 9. Rancangan API

Base: `/api/v1` · JWT Bearer · error `{ code, message, details }` dengan `code` merujuk BR-xx bila berupa pelanggaran aturan bisnis.

### Auth
| Method | Path | Keterangan |
|---|---|---|
| GET | `/auth/operators` | Daftar operator aktif (id + nama saja) |
| POST | `/auth/login` | `{ operatorId, pin }` → token |
| POST | `/auth/refresh` | Perbarui access token |
| POST | `/auth/logout` | Cabut refresh token |

### Master
| Method | Path | Keterangan |
|---|---|---|
| GET | `/silos` | Daftar silo + volume (dari VIEW) |
| GET | `/silos/:id` | Detail + riwayat |
| GET | `/silos/by-qr/:qr` | Resolusi QR (FR-3.2) |
| GET | `/suppliers` · `/tanks` | Master aktif |

### Dashboard
| Method | Path | Keterangan |
|---|---|---|
| GET | `/dashboard/silos` | Kartu lengkap: volume, pH/suhu/TS, status monitoring, standing time |
| GET | `/dashboard/summary` | Total volume, total kapasitas, badge antrean |

### Transaksi
| Method | Path | Keterangan |
|---|---|---|
| GET/POST | `/receiving` | Daftar (paginated) / buat |
| POST | `/receiving/:id/correct` | Koreksi (BR-12) |
| GET | `/prepast/buffer-queue` | Antrean buffer FIFO (FR-5.1) |
| POST | `/prepast` | Buat, mengurangi induk (FR-5.6) |
| POST | `/prepast/:id/correct` · `/prepast/:id/complete-gantung` | BR-12 · BR-16 |
| GET | `/transfer/fifo-preview?siloId=&volume=` | Pratinjau alokasi (FR-6.3) |
| POST | `/transfer` | Buat, transaksional |
| POST | `/transfer/:id/correct` · `/transfer/:id/complete-gantung` | BR-12 · BR-16 |
| GET/POST | `/monitoring` | Daftar / buat |
| GET | `/stock-opname?periode=` · PUT `/stock-opname` | Ambil / upsert batch (FR-8.4) |

### Approval & Koreksi
| Method | Path | Keterangan |
|---|---|---|
| GET | `/approval/queue?module=` | Antrean pending |
| POST | `/approval/:module/:id/approve` | FR-9.2 |
| POST | `/approval/:module/:id/reject` | FR-9.3, guard BR-15 |
| GET | `/approval/edit-requests?module=` | FR-9.5 |
| POST | `/approval/edit-requests/:id/{grant,deny}` | FR-9.5 |
| POST | `/records/:module/:id/request-edit` | FR-10.4 |
| POST | `/records/:module/:id/void` | BR-13, BR-14 |
| GET | `/records/:module/:id/dependencies` | BR-15, untuk popup peringatan |

### Export & Pratinjau
| Method | Path | Keterangan |
|---|---|---|
| POST | `/export/rekap` | `{ rangeType, startDate }` → `jobId` |
| GET | `/export/jobs/:id` | Status |
| GET | `/export/jobs/:id/download` | Unduh file |
| GET | `/export/preview?date=&page=` | Struktur tata letak form untuk pratinjau — FR-28.7, sumber yang sama dengan generator Excel |
| GET | `/export/validate?rangeType=&startDate=` | Temuan validasi pra-export (pemblokir & peringatan) — FR-28.3 |

### Dashboard
| Method | Path | Keterangan |
|---|---|---|
| GET | `/dashboard/kpi?from=&to=` | Baris ringkasan — FR-27.2 |
| GET | `/dashboard/attention` | Panel perhatian gabungan — FR-27.3 |
| GET | `/dashboard/balance?from=&to=` | Neraca masuk vs keluar — FR-27.4.1 |
| GET | `/dashboard/arrival-heatmap?from=&to=` | Pola jam kedatangan — FR-27.4.2 |
| GET | `/dashboard/silo-activity?from=&to=` | Aktivitas per silo — FR-27.4.3 |
| GET | `/dashboard/quality?metric=&from=&to=` | `temp_storage` · `ph` · `temp_heater` · `temp_output` · `ts` |
| GET | `/dashboard/by-supplier?from=&to=` | Volume & TS per supplier — FR-27.4.8/9 |
| GET | `/dashboard/standing-time` | Sebaran standing time — FR-27.4.10 |
| GET | `/dashboard/:panel/export?format=csv` | Ekspor data panel — FR-27.1.6 |

Seluruh endpoint dashboard mengembalikan data **teragregasi**, tidak pernah baris mentah (D-7.1).

---

## 10. Non-Functional Requirements

| ID | Kategori | Requirement |
|---|---|---|
| NFR-1 | Performa | Dashboard tampil < 1,5 detik pada 50 silo & 100.000 baris transaksi |
| NFR-2 | Performa | Submit transaksi (termasuk alokasi FIFO) selesai < 800 ms p95 |
| NFR-3 | Skala | Benar pada 500.000+ baris — tanpa batas 2.000 baris SharePoint |
| NFR-4 | Konkurensi | 30 pengguna simultan; alokasi FIFO bebas dari lost update |
| NFR-5 | Integritas | Setiap perubahan volume bersifat transaksional; sistem tidak pernah menyimpan state separuh |
| NFR-6 | Audit | Setiap create/approve/reject/void/correct tercatat di `audit_log` beserta aktornya. Tabel bersifat append-only dan memenuhi syarat A-1..A-8 (lihat 15.3.1) — 21 CFR Part 11 §11.10(e), ISO 22000 kl. 7.5/8.3, ALCOA+ |
| NFR-7 | Keamanan | PIN di-hash argon2id; JWT; rate limit; RBAC ditegakkan di server, bukan lewat visibilitas tombol |
| NFR-8 | Perangkat | Tablet 1024×768 sebagai target utama; area sentuh ≥ 44 px; desktop ≥ 1280 px |
| NFR-9 | Ketersediaan | Uptime 99,5% jam operasional; RTO 4 jam; backup harian dengan retensi 30 hari |
| NFR-10 | Resiliensi | Kehilangan koneksi sesaat tidak menyebabkan submit ganda (idempotency key per submit) |
| NFR-11 | Observability | Log terstruktur; metrik latensi & error rate per endpoint |
| NFR-12 | Bahasa | Antarmuka Bahasa Indonesia, mempertahankan istilah operasional yang sudah dikenal (Prepast, Gantung, Standing Time, Buffer) |

---

## 11. Strategi Migrasi Data

### 11.1 Urutan

1. Master: `operator` → `supplier` → `silo` → `tank_master`
2. `receiving`
3. `prepast_record` (resolusi `id_receiving` string → FK)
4. `transfer` (resolusi tank & silo tujuan dari `tank_trf_qr_value`)
5. `transfer_allocation` (**parse `supplier_fifo` JSON → baris**)
6. `monitoring`, `stock_opname`
7. Rekonsiliasi & verifikasi

### 11.2 Transformasi Kritis

| Isu | Penanganan |
|---|---|
| Datetime string `"mm/dd/yyyy hh:mm"` | Parse eksplisit dengan format tetap. String kosong → `NULL` (record GANTUNG). String tidak valid masuk laporan pengecualian, tidak boleh ditebak. |
| `supplier_fifo` JSON | Parse per transfer, satu baris per elemen. Elemen yang `id_prepast`-nya tidak ditemukan dicatat sebagai yatim dan direview manual. |
| PIN plaintext | Tidak dimigrasikan. Semua operator mendapat PIN baru saat go-live; kolom `pin_hash` diisi lewat proses reset terkendali. |
| ID acak duplikat | Deteksi duplikat `Title` per prefix+tanggal; selesaikan manual sebelum memuat `UNIQUE`. |
| Anak PINDAH SILO | Identifikasi lewat `transfer_ref = "<asal>-TO-<tujuan>"`, isi `parent_prepast_id` dan `transfer_ref_id`. Pola string ini tidak unik bila ada beberapa transfer antar pasangan silo yang sama pada rentang waktu tumpang tindih — kasus tersebut butuh review manual. |
| `FM_Batch_Traceability` | Dimuat apa adanya ke tabel staging, menunggu keputusan Bagian 4.3. |

### 11.3 Verifikasi

Migrasi dinyatakan berhasil bila:

- **V-1** Volume tiap silo di `v_silo_volume` sama persis dengan yang ditampilkan Power Apps pada saat cutover (toleransi 0 liter).
- **V-2** Jumlah baris per tabel cocok dengan jumlah item SharePoint, dikurangi pengecualian yang terdokumentasi.
- **V-3** Setiap prepast punya induk receiving yang valid, kecuali anak PINDAH SILO.
- **V-4** `SUM(transfer_allocation.qty_allocated)` per transfer = `transfer.vol_ltr`.
- **V-5** Tidak ada `qty_remaining_ltr` negatif atau melebihi volume asalnya.
- **V-6** Setiap silo dengan volume > 0 dan `standing_time_anchor` NULL masuk laporan review.

### 11.4 Cutover

Big-bang dengan periode beku, bukan paralel-run. Menjalankan dua sistem berdampingan berarti dua sumber kebenaran untuk volume silo — risikonya lebih besar daripada manfaatnya.

1. H-7: dry run migrasi ke staging, verifikasi V-1..V-6, UAT operator & SPV
2. H-1: pembekuan input, selesaikan seluruh record GANTUNG dan pending approval bila memungkinkan
3. H: migrasi final di luar jam operasional, verifikasi ulang, go-live
4. H+7: Power Apps dijadikan read-only sebagai rujukan, tidak dihapus
5. H+30: Power Apps dipensiunkan

---

## 12. Roadmap

| Fase | Durasi | Isi | Milestone |
|---|---|---|---|
| **0 — Fondasi** | 2 minggu | Skema DB, VIEW, seed, auth, shell UI, CI | Login berfungsi, dashboard menampilkan data seed |
| **1 — Alur Inti** | 4 minggu | Receiving, Prepast, Transfer + FIFO, Monitoring, pemindai QR | Alur hulu-hilir lengkap dengan alokasi FIFO benar |
| **2 — Tata Kelola** | 3 minggu | Approval, Data List, koreksi & void, dependency guard, GANTUNG, audit log | Seluruh business rule BR-01..BR-20 tertutup test |
| **3 — Pelengkap** | 2 minggu | Stock Opname, Detail Silo + filter, Export Excel | Kesetaraan fitur tercapai |
| **3b — Master Data** | 2 minggu | CRUD silo, supplier, operator, tank, prefiks batch, template form (FR-26) | Master data dapat dikelola tanpa DBA |
| **3c — Dashboard & Pratinjau** | 3 minggu | Dashboard analitik (FR-27), pratinjau form GMP (FR-28) | Tren & penyimpangan terlihat; export tervalidasi sebelum terbit |
| **4 — Migrasi & Go-live** | 2 minggu | Skrip migrasi, dry run, UAT, cutover | Produksi |
| **Total** | **18 minggu** | | |

FR-29 (input prepast multi-silo) dan FR-30 (pola efisiensi input) **tidak menambah fase** — keduanya dikerjakan di dalam Fase 1 dan 2 sebagai bagian dari pembangunan form yang bersangkutan. Membangun form satu-silo lebih dulu lalu mengubahnya justru lebih mahal daripada langsung membangun bentuk akhirnya.

Fase 2 sengaja tidak dipadatkan. Di situlah letak seluruh logika reversal, dan bug di area itu merusak data historis secara diam-diam.

### 12.6 Tahap Lanjutan (Di Luar 18 Minggu)

Dua kemampuan sengaja ditunda ke tahap berikutnya. Keduanya bertumpu pada fondasi yang dibangun di Fase 1–4, sehingga menundanya tidak menimbulkan pekerjaan ulang.

#### L-1 · Saldo Berjalan per Silo

*Ditunda atas keputusan 25 Agustus 2026.*

Alurnya: Admin menginput volume awal bulan hasil Stock Opname, lalu **kolom "Jumlah Awal (lt)" pada blok transfer di form GMP terisi dari situ**, dan "Saldo (lt)" berjalan mengikutinya:

```
Saldo(t) = Jumlah Awal bulan berjalan
         + Σ prepast masuk sampai t
         − Σ transfer keluar sampai t
```

Ini menutup B-17 dan mengaktifkan dua kolom form yang sejak awal kosong. Yang membuatnya bernilai bukan sekadar mengisi kolom, melainkan **rekonsiliasi**: selisih antara saldo yang dihitung sistem dan hasil hitung fisik Stock Opname bulan berikutnya menjadi angka susut yang selama ini tidak pernah terukur.

Prasyarat yang sudah tersedia setelah Fase 4: Stock Opname yang upsert-nya benar (memperbaiki B-2), `v_silo_volume` sebagai sumber tunggal volume, dan generator form yang tata letaknya sudah presisi.

#### L-2 · Modul Batch Traceability

Sudah diuraikan di 4.3 (keputusan D-1). Menyambung dari titik akhir Transfer ke batch produk jadi. Prasyaratnya adalah alokasi FIFO yang transaksional (Fase 1) dan batch number yang seragam (BR-21) — keduanya selesai di dalam 18 minggu.

L-1 sebaiknya didahulukan: cakupannya jauh lebih kecil, dan angka rekonsiliasi yang dihasilkannya berguna bagi produksi sejak bulan pertama.

### 12.5 Catatan Penambahan Fase 3c

Dashboard analitik (FR-27) dan pratinjau form (FR-28) menambah 3 minggu. Keduanya adalah kemampuan baru — tidak ada padanannya di aplikasi lama — tetapi seluruh datanya **sudah tersimpan sejak awal**; yang belum ada hanyalah cara membacanya.

Dua catatan penempatan:

**Dashboard menuntut data historis yang bersih.** Menempatkannya sebelum Fase 4 berarti ia diuji dengan data hasil migrasi yang sesungguhnya, bukan data contoh — sehingga anomali seperti B-16 (tanggal tertukar) dan B-20 (batch tak seragam) terlihat sebagai grafik yang janggal, bukan sebagai temuan yang lolos ke produksi. Dashboard menjadi alat verifikasi migrasi sekaligus fitur.

**Pratinjau form (FR-28) memakai ulang generator export dari Fase 3.** Karena FR-28.7 mensyaratkan satu definisi tata letak dengan dua penyaji, pratinjau harus dikerjakan **setelah** generator Excel selesai, bukan paralel. Membaliknya berarti membangun tata letak dua kali.

### 12.4 Catatan Penambahan Fase 3b

Estimasi naik dari 13 menjadi 15 minggu karena modul manajemen master data (FR-26). Penting untuk dipahami bahwa **ini bukan penambahan cakupan, melainkan penggantian kemampuan yang hilang.**

Selama aplikasi bertumpu pada SharePoint, master data dikelola lewat antarmuka SharePoint List — gratis, tanpa perlu dibangun. Itulah sebabnya aplikasi Power Apps tidak punya satu pun layar pengelolaan master data: platform sudah menyediakannya. Begitu data berpindah ke MySQL, antarmuka itu ikut hilang.

Tanpa Fase 3b, setiap pekerjaan berikut akan menuntut intervensi DBA:

- menambah supplier baru
- mengubah kapasitas atau ketersediaan silo
- menambah atau menonaktifkan operator, mereset PIN
- menambah tank
- menambah prefiks batch
- menerbitkan revisi form baru dari QA

Semuanya adalah pekerjaan rutin operasional, bukan pekerjaan teknis. Menundanya berarti memindahkan beban administratif harian ke tim IT.

**Bila jadwal harus dipangkas,** FR-26.1 s/d FR-26.5 (supplier, silo, operator, tank, prefiks batch) adalah minimum yang tidak dapat dilepas. FR-26.6 (template form) dapat ditunda karena revisi dokumen QA jarang terjadi — sementara itu nilainya di-seed langsung ke basis data.

---

## 13. Risiko

| ID | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| R-1 | Logika FIFO/reversal salah diterjemahkan | Tinggi | `allocateFifo()` sebagai fungsi murni dengan suite test berbasis skenario nyata; bandingkan hasil terhadap 100 transfer historis |
| R-2 | Data historis kotor menghambat migrasi | Tinggi | Dry run lebih awal; laporan pengecualian; sediakan waktu pembersihan manual di Fase 4 |
| R-3 | Format Excel `ExportRekapFM` tidak diketahui | Sedang | Ekspor definisi flow di awal Fase 0; bila tidak tersedia, rekonstruksi dari file output terakhir |
| R-4 | ~~Cakupan `FM_Batch_Traceability` belum jelas~~ | — | **Tertutup 25 Ags 2026** — di luar cakupan Fase 1, data dimigrasikan read-only (lihat 4.3) |
| R-9 | Jalur reject Receiving/Prepast/Transfer belum pernah dipakai di produksi, sehingga belum teruji lapangan | Sedang | Sertakan skenario reject keempat modul dalam UAT Fase 2, termasuk kasus guard dependensi BR-15 yang ikut aktif untuk pertama kalinya |
| R-5 | Operator terbiasa dengan tata letak lama | Sedang | Pertahankan alur navigasi & istilah; UAT dengan operator sungguhan di Fase 3 |
| R-6 | Kamera QR di browser kurang andal di lingkungan pabrik | Sedang | Dropdown manual sebagai fallback setara (sudah ada di app lama); pertimbangkan scanner USB HID |
| R-7 | Reset PIN massal saat go-live mengganggu shift | Rendah | Distribusikan PIN baru H-1; siapkan jalur reset darurat untuk SPV |
| R-8 | Bug lama dianggap fitur oleh pengguna | Rendah | Konfirmasikan tiap perbaikan di Bagian 14 dengan pemilik proses sebelum implementasi |

---

## 14. Bug yang Ditemukan Selama Analisa

Ditemukan saat membaca YAML. Masing-masing perlu keputusan eksplisit: perbaiki atau replikasi.

| # | Lokasi | Temuan | Rekomendasi |
|---|---|---|---|
| B-1 | Semua modul | ID dari `RandBetween(100,999)` — hanya 900 nilai per hari per prefix | Perbaiki (sequence) |
| B-2 | `Scr_SO_Input` `Btn_Export` | `If(silo_number, Patch(..., LookUp(..., ID = silo_number), ...))` — string dipakai sebagai kondisi boolean dan dicocokkan ke kolom numerik; upsert tidak bekerja | Perbaiki |
| B-3 | `Scr_SO_Input` | `Notify()` validasi tidak menghentikan eksekusi; simpan tetap berjalan dengan field kosong | Perbaiki |
| B-4 | `Scr_Approval` `lblEditReq` | Cabang `"Prepast"` menghitung `colEditRequestsTransfer` | Perbaiki |
| B-5 | `Scr_Approval` | Ikon reject `Visible: =false` di tab Receiving, Transfer, Prepast — hanya Monitoring yang bisa direject | **Perbaiki.** Dikonfirmasi bug (25 Ags 2026): reject di ketiga modul memang belum pernah terpakai, tetapi idealnya terpakai. Lihat catatan di bawah tabel. |
| B-6 | `Scr_Approval` `btnNoReject_1` | Tombol "No" pada dialog Edit Request menampilkan "Edit Request Approved" | Perbaiki teks |
| B-7 | `Scr_Detail` `galReceivingDetail` | `StartsWith(finish_time, Text(tanggal,"mm"))` — hanya cocok bulan, dan lintas tahun | Perbaiki (FR-11.3) |
| B-8 | `Scr_Approval`, gallery Transfer | Menampilkan `vol_total_ltr` (kolom bertipe teks, tampak tidak terisi) alih-alih `vol_ltr` | Perbaiki |
| B-9 | `Scr_Receiving_Input` `lblSiloCapacity` | Kapasitas tersisa hanya memfilter `status_fifo`, mengabaikan `status_approval` → menghitung record VOIDED/REVISED | Perbaiki |
| B-10 | `Scr_Transfer_Input` `txtBatch` | `If(cond1, a, If(cond2, b), "")` — argumen `else` tersisip salah tempat, hasilnya `Blank()` bukan `""` | Perbaiki |
| B-11 | `FM_Receiving_Penerimaan` | Kolom internal `start_time` bernama tampilan `finish_time`; formula memakai nama tampilan | Perbaiki saat migrasi (kolom `finish_time`) |
| B-12 | `FM_Prepast_Record` | Kolom `approved_by ` memiliki spasi di akhir nama, dirujuk sebagai `'approved_by '` | Perbaiki saat migrasi |
| B-13 | Dependency guard | Menggunakan `Title in supplier_fifo` (substring match pada JSON) — `PST-20260825-001` cocok dengan `PST-20260825-0011` | Perbaiki (tabel `transfer_allocation`) |
| B-14 | `Silo_Master.vol_aktual_ltr` | Kolom ada tapi tidak pernah menjadi sumber kebenaran; `Scr_Monitoring_Input` menyimpannya sebagai snapshot padahal isinya bisa basi | Perbaiki (snapshot dari VIEW) |

### 14.1 Temuan Tambahan dari Analisa File Export

Enam cacat berikut **tidak terlihat dari kode aplikasi** dan hanya muncul setelah membandingkan output export terhadap input aplikasi. Uraian lengkap ada di Lampiran C.5.

| # | Temuan | Bukti | Rekomendasi |
|---|---|---|---|
| ~~B-15~~ | ~~Kolom form "Waktu Penerimaan → Mulai" kosong~~ | — | **Dicabut 25 Ags 2026** — kolom memang ada di form tetapi secara prosedur tidak diisi; pencatatan langsung ke "Selesai". Bukan bug. B-11 (penamaan kolom skema) tetap berlaku. |
| B-16 | **Tanggal form tertukar hari/bulan pada tanggal 1–12** (1 Agustus tertulis 8 Januari); tanggal 13–31 tersimpan sebagai teks | 12 dari 20 file salah tanggal | Perbaiki — cacat kepatuhan pada dokumen bertanda tangan |
| B-17 | "Jumlah Awal (lt)" dan "Saldo (lt)" tidak pernah terisi | 20 file, 8 silo | Perbaiki — bukti lapangan yang mengonfirmasi B-2 |
| B-18 | "Disimpan di Silo No" tanpa deduplikasi (`SILO25A/25A`, `SILO6/6/25A`) **dan mencampur nama tampilan dengan kode** (`SILO25B/1/3/25A`) | 32 nilai unik | Perbaiki (FR-12.9) |
| B-19 | **TERKONFIRMASI.** Nama silo tersimpan tanpa spasi (`SILO25A`) sementara `Scr_Home` membandingkan dengan spasi (`"SILO 25A"`) → **ambang 2 jam BR-10 tidak pernah aktif sejak awal** | 141 penulisan `SILO25A`/`SILO25B` tanpa spasi, nol dengan spasi; dikuatkan batch `TF TO SILO25A` yang dibuat sistem — lihat 14.3 | **Perbaiki di Power Apps sekarang**, jangan tunggu migrasi |
| B-20 | 139 batch unik dari 336 penulisan. Konvensi resmi (`CMD2` · `HC1` · `FC1`) hanya menutup ~50% data: lapangan memakai `HRC` bukan `HC`, posisi angka terbelah (`1HRC` vs `HRC1`), dan ada 3 jenis batch tak terdaftar (`INK` 52×, `FULLFM`, `SR`) | 20 hari data transfer | Normalisasi bertahap — prasyarat modul traceability (D-1). Tahap 1–2 menunggu D-13 |

**B-19 layak ditangani lebih dulu.** Berbeda dari temuan lain, ini bug produksi yang aktif saat ini dan perbaikannya di Power Apps hanya menyentuh satu formula. Menunggu 13 minggu untuk memperbaikinya berarti membiarkan peringatan monitoring dua silo tetap meleset selama itu.

### 14.3 B-19 Terkonfirmasi — dan Layak Diperbaiki Sekarang

*Diverifikasi 25 Agustus 2026 terhadap 20 file export.*

Sebelumnya B-19 berstatus dugaan. Verifikasi terhadap data nyata mengubahnya menjadi **temuan pasti**, lewat dua jalur bukti yang saling bebas.

**Bukti 1 — nilai `silo_name` sebagaimana ditulis aplikasi.** Kolom "Disimpan di Silo No" pada form berisi `prepast.silo_tujuan_display`, yang di aplikasi diisi dari `ddSiloTujuan.Selected.silo_name.Value`:

```
SILO25A   73×        SILO3     10×
SILO25B   68×        SILO1      6×
SILO2      8×        SILO6      3×

Dengan spasi:  0×
```

**Bukti 2 — batch yang dibuat sistem sendiri.** Pada PINDAH SILO, aplikasi merakit batch sebagai `"TF TO " & varSelectedSiloTarget.silo_name.Value`. Bila `silo_name` bernilai `"SILO 25A"`, batch itu akan terbaca `TF TO SILO 25A`. Yang tercatat:

```
TF TO SILO1 · TF TO SILO2 · TF TO SILO3 · TF TO SILO6 · TF TO SILO25A · TF TO SILO25B
```

Tidak ada spasi. Ini adalah string yang dirakit aplikasi dari nilai aslinya, bukan hasil ketikan operator — sehingga tidak mungkin keliru.

**Kontrol — apakah spasi mungkin hilang di jalur export?** Tidak. Kolom teks lain di file yang sama mempertahankan spasinya utuh: `Ade Yudistira`, `Aneka Karya Boyolali`, `KUD Mandiri Bayongbong`. Export tidak menghapus spasi.

**Kesimpulan.** `silo_name.Value` bernilai `"SILO25A"`. Perbandingan di `Scr_Home`:

```
intJam: If(
    ThisItem.silo_name.Value = "SILO 25A" || ThisItem.silo_name.Value = "SILO 25B",
    2, 4
)
```

**tidak pernah bernilai benar.** Ambang selalu jatuh ke 4 jam, dan BR-10 — aturan 2 jam untuk kedua silo tersebut — tidak pernah aktif sejak formula itu ditulis.

**Dampak nyata.** Data monitoring memperlihatkan operator sudah menjalankan aturannya dengan benar. Pada 6 Agustus, Silo 25A dicek pukul 08, 10, 12, 14, 19, 21, 23 — interval 2 jam. Yang tidak berjalan adalah **jaring pengamannya**: peringatan "Perlu dicek!" pada kartu silo baru menyala setelah 4 jam, sehingga keterlambatan antara jam ke-2 dan ke-4 tidak pernah terdeteksi sistem. Selama ini kepatuhan bertumpu sepenuhnya pada kedisiplinan operator, tanpa lapisan kedua.

Ini penting justru karena SILO 25A dan 25B adalah dua silo tersibuk — 141 dari 171 penerimaan bermuara ke sana.

#### Perbaikan segera (tidak menunggu migrasi)

Perbaikannya menyentuh satu formula di `Scr_Home`, dan tidak bergantung pada apa pun dalam proyek migrasi:

```
// Bandingkan terhadap kode silo, bukan nama tampilan.
// Title bernilai "25A"/"25B", stabil dan tidak mengandung spasi.
intJam: If(
    ThisItem.Title = "25A" || ThisItem.Title = "25B",
    2, 4
)
```

Memakai `Title` lebih baik daripada sekadar membuang spasi pada perbandingan lama, karena `Title` adalah kode yang memang dimaksudkan sebagai pengenal — sementara `silo_name` adalah label tampilan yang sewaktu-waktu dapat diubah orang tanpa menyadari ada formula yang bergantung padanya.

Formula serupa juga muncul di `timerRefresh.OnTimerEnd` (kolom `intJamThreshold`) dan perlu diperbaiki bersamaan.

**Setelah migrasi, kelas bug ini hilang seluruhnya.** Ambang menjadi kolom `silo.monitoring_interval_jam` yang disunting lewat Manajemen Silo (FR-26.2.4) — tidak ada lagi perbandingan string, dan menambah silo dengan ambang khusus tidak lagi menuntut perubahan kode.

#### Catatan tambahan untuk B-18

Verifikasi yang sama memperlihatkan bahwa penggabungan silo pada kolom N **mencampur dua bentuk penamaan**:

```
SILO25B/1/3/25A
└─ nama tampilan ─┘ └─ kode ─┘
```

Elemen pertama memakai nama tampilan (`SILO25B`), elemen berikutnya memakai kode (`1`, `3`, `25A`). Pembaca form melihat satu kolom dengan dua konvensi berbeda di dalamnya. FR-12.9 diperjelas: seluruh elemen memakai **nama tampilan**, seragam.

### 14.2 Temuan dari Penetapan Matriks Peran

| # | Lokasi | Temuan | Rekomendasi |
|---|---|---|---|
| B-21 | `Scr_Login` vs `Scr_DataList` | **`varIsSpv` dihitung dengan dua rumus berbeda.** Saat login: `role = "SPV" \|\| role = "Admin"`. Saat membuka Data List: `role = "SPV"` saja. Akibatnya Admin memiliki wewenang setingkat SPV di seluruh aplikasi, **kecuali** di layar Data List — di sana wewenangnya tiba-tiba dicabut. | Perbaiki. Dengan matriks peran 2.10.1, `varIsSpv` digantikan pemeriksaan wewenang eksplisit di server. |
| B-22 | Seluruh aplikasi | Otorisasi ditegakkan **hanya lewat properti `Visible` tombol**. Tidak ada pemeriksaan wewenang pada operasi tulis itu sendiri — siapa pun yang dapat memanggil `Patch` dapat menyetujui atau mem-void record. | Perbaiki. Wewenang diperiksa di endpoint, bukan di UI (BR-22, NFR-7). |

Kedua temuan ini berkaitan. B-21 muncul justru karena wewenang tersebar sebagai variabel global yang dihitung ulang di beberapa tempat; begitu wewenang berpindah ke server dan diperiksa per endpoint, kelas bug ini hilang seluruhnya.

**Catatan B-5 — jalur reject sebagai fitur yang belum pernah aktif.** Dikonfirmasi bahwa reject di modul Receiving, Prepast, dan Transfer belum pernah dipakai di produksi karena tombolnya memang tersembunyi, tetapi jalur itu **memang dimaksudkan untuk dipakai**. Ini mengubah statusnya dari sekadar perbaikan tampilan menjadi fitur yang praktis baru:

- Logika reject-nya sendiri sudah lengkap di `btnYesReject` untuk keempat modul, termasuk guard dependensi BR-15 (Receiving tidak dapat direject bila punya Prepast anak; Prepast tidak dapat direject bila direferensikan Transfer). Kode itu **belum pernah dijalankan dalam kondisi nyata.**
- Implikasi data: sampai hari ini praktis tidak ada record `Rejected` di ketiga modul tersebut. Skrip migrasi tidak boleh berasumsi status itu pernah muncul, dan sebaliknya tidak boleh menganggap ketiadaannya sebagai kelainan data.
- Implikasi alur: begitu reject aktif, status `Rejected` menjadi jalur masuk nyata ke mekanisme koreksi (FR-10.2 memperbolehkan Operator mengedit record `Rejected`). Alur Rejected → koreksi → submit ulang → approve perlu diuji utuh, bukan hanya aksi reject-nya.
- Ditambahkan sebagai risiko R-9 dan masuk cakupan UAT Fase 2.

---

## 15. Analisa Efektivitas Workflow & Usulan Perbaikan

Bagian 5–6 mendefinisikan kesetaraan fitur. Bagian ini melihat lebih jauh: **mana alur kerja yang tidak efektif dan sebaiknya dirancang ulang.**

Prinsip yang dipakai untuk memisahkan mana yang boleh diubah dan mana yang tidak:

> **Aturan bisnis tidak boleh berubah. Tambalan platform boleh dan harus dibuang.**

Banyak kerumitan di aplikasi eksisting bukan berasal dari proses pabrik, melainkan dari keterbatasan Power Apps — tidak ada datetime picker gabungan, tidak ada audit log, tidak ada transaksi, tidak ada bulk action. UI menambalnya dengan kontrol terpisah, flag global, dan record REVISED. Setelah pindah ke stack web, tambalan itu berubah dari solusi menjadi beban.

### 15.1 Ringkasan Temuan

| ID | Workflow | Masalah | Usulan | Dampak | Risiko |
|---|---|---|---|---|---|
| **WF-1** | Input tanggal & jam | 3 kontrol terpisah + 6 aturan validasi manual | Satu input `datetime-local` | Tinggi | Rendah |
| **WF-2** | Koreksi record Pending | Reversal + record baru meski belum pernah disetujui | Edit in-place + audit log untuk record Pending | Tinggi | Sedang |
| **WF-3** | Request Edit | 4 langkah bolak-balik Operator ↔ SPV | 2 langkah: ajukan perubahan, SPV setujui | Tinggi | Rendah |
| **WF-4** | Approval | Satu klik per record, 4 tab terpisah | Bulk approve + antrean terpadu | Tinggi | Rendah |
| **WF-5** | Dependency guard | Popup buntu, operator cari sendiri record turunan | Cascade terpandu dengan aksi void inline | Tinggi | Sedang |
| **WF-6** | Refresh data | 7 tombol refresh manual + Timer | Invalidasi otomatis | Sedang | Rendah |
| **WF-7** | GANTUNG | Mode & rute terpisah, toggle manual | Status `DRAFT` alami + daftar "perlu dilengkapi" | Sedang | Rendah |
| **WF-8** | Navigasi modul | Receiving & Prepast lewati pemilihan silo, Transfer & Monitoring tidak | Pola konsisten: pilih konteks → isi form | Sedang | Rendah |
| **WF-9** | Transfer volume penuh | Ketik angka manual meski niatnya mengosongkan silo | Tombol "Transfer Semua" + slider | Sedang | Rendah |
| **WF-10** | Export bulanan | Menghasilkan 30 file Excel terpisah | Satu workbook, satu sheet per hari | Sedang | Rendah |
| **WF-11** | Monitoring | Tidak ada pengingat, operator harus memantau dashboard | Antrean "Jatuh Tempo Cek" + notifikasi | Sedang | Rendah |
| **WF-12** | Stock Opname | Simpan lalu reload halaman penuh | Simpan inkremental per baris | Rendah | Rendah |
| **WF-13** | Login | Dropdown seluruh nama operator | Input NIK/badge + PIN | Rendah | Rendah |

### 15.2 WF-1 — Input Tanggal & Jam

**As-Is.** Setiap waktu diisi lewat tiga kontrol: DatePicker, TextInput jam (`MaxLength=2`), TextInput menit (`MaxLength=2`), dipisahkan label `":"`. Pola ini berulang di lima layar dengan total delapan set. Konsekuensinya, tiap tombol submit membawa rangkaian validasi manual:

```
Len(txtStartHourPrp.Text) <> 2 || Len(txtStartMinutePrp.Text) <> 2 ||
Len(txtFinishHourPrp.Text) <> 2 || Len(txtFinishMinutePrp.Text) <> 2 ||
Value(txtStartMinutePrp.Text) > 59 || Value(txtFinishMinutePrp.Text) > 59
→ "Jam & menit harus 2 digit (contoh: 04, bukan 4)."
```

Nilai lalu dirakit menjadi string `Text(tanggal,"mm/dd/yyyy") & " " & jam & ":" & menit`, dan saat dibaca kembali dibongkar dengan `Mid(field, 12, 2)` dan `Mid(field, 15, 2)` — offset karakter yang di-hardcode dan pecah begitu formatnya bergeser satu karakter.

**To-Be.** Satu input `datetime-local` per titik waktu. Kontrol browser menjamin nilainya valid, sehingga:

- Enam aturan validasi "2 digit" dan "menit ≤ 59" **hilang seluruhnya** — bukan dipindahkan, tetapi tidak lagi relevan.
- Perakitan dan pembongkaran string hilang; nilai mengalir sebagai `Date` dari form ke kolom `DATETIME`.
- Aturan rollover tengah malam (BR-11) **tetap dipertahankan** sebagai perilaku bantuan: bila pengguna memilih waktu selesai lebih awal dari waktu mulai, sistem menyarankan tanggal +1 hari dengan konfirmasi eksplisit, bukan diam-diam menggeser seperti sekarang.

**Yang berubah bagi operator:** satu ketukan menggantikan tiga, dan tidak ada lagi penolakan karena mengetik `4` alih-alih `04`.

**Requirement baru.** `FR-13.1` Seluruh input waktu menggunakan kontrol datetime tunggal. `FR-13.2` Rollover tengah malam disarankan, bukan diterapkan diam-diam.

### 15.3 WF-2 — Koreksi Record yang Belum Disetujui

**As-Is.** Setiap koreksi, tanpa memandang status, menempuh jalur reversal + re-entry: record lama ditandai `REVISED`, volume dikembalikan ke hulu, record baru dibuat dengan `correction_ref`. Untuk record yang **sudah `Approved`**, ini benar dan wajib dipertahankan — jejak persetujuan tidak boleh dihapus.

Namun untuk record yang masih `Pending Approval` atau `Rejected`, operator sedang memperbaiki sesuatu yang **belum pernah disetujui siapa pun**. Salah ketik berat jenis lima menit setelah submit menghasilkan dua baris permanen di database dan satu perjalanan reversal penuh. Pada Transfer, koreksi tunggal berarti: kembalikan alokasi ke N prepast → void anak PINDAH SILO → tandai REVISED → hitung ulang FIFO → sisipkan transfer baru → alokasikan ulang ke N prepast. Sekitar 2N+4 operasi tulis untuk mengubah satu angka.

**To-Be.** Bercabang berdasarkan status:

| Status record | Mekanisme koreksi |
|---|---|
| `Pending Approval` · `Rejected` | **Edit in-place** dalam satu transaksi: hitung delta volume, terapkan ke hulu, perbarui baris. Nilai sebelum & sesudah tercatat di `audit_log`. |
| `Approved` | **Reversal + re-entry** seperti sekarang (BR-12 tetap berlaku penuh). |

Ini menjadi mungkin justru karena `audit_log` (NFR-6) tidak ada padanannya di aplikasi lama. Jejak "siapa mengubah apa, dari nilai berapa ke berapa" yang dulu hanya bisa direkam dengan menyisakan baris `REVISED`, kini direkam secara eksplisit.

**Dampak.** Tabel transaksi menyusut signifikan — perkiraan kasar, sebagian besar record `REVISED` yang ada saat ini berasal dari koreksi pra-approval. DataList jadi lebih mudah dibaca karena tidak dipenuhi baris REVISED yang tidak menarik bagi siapa pun.

**Requirement baru.** `FR-14.1` Koreksi record pra-approval dilakukan in-place dengan `audit_log` before/after. `FR-14.2` Koreksi record `Approved` tetap memakai reversal + re-entry.

#### 15.3.1 Dasar Kepatuhan untuk Pilihan Jejak Audit

**Keputusan (25 Agustus 2026): pendekatan `audit_log` diadopsi, dengan delapan syarat pengerasan di bawah.**

Pertanyaannya adalah apakah setiap versi record wajib tersimpan sebagai baris terpisah di tabel transaksi, atau cukup sebagai entri log. Standar yang berlaku menjawabnya dengan cukup jelas: **yang disyaratkan bukan bentuk penyimpanannya, melainkan sifat-sifatnya.**

| Rujukan | Yang disyaratkan |
|---|---|
| **ISO 22000:2018** klausul 8.3 (Traceability) & 7.5 (Documented information) | Rekaman harus dipelihara, dapat ditelusuri, dan terlindungi dari perubahan yang tidak diinginkan |
| **ISO 9001:2015** klausul 7.5.3.2 | Perubahan pada rekaman harus **terkendali** — bukan berarti harus menjadi baris baru |
| **21 CFR Part 11** §11.10(e) | Audit trail yang aman, dihasilkan komputer, dan berstempel waktu; **"record changes shall not obscure previously recorded information"** |
| **Prinsip ALCOA+** (WHO/PIC-S, diadopsi luas di industri pangan) | Attributable · Legible · Contemporaneous · Original · Accurate · Complete · Consistent · Enduring · Available |

Kalimat kunci ada di 21 CFR Part 11: perubahan **tidak boleh mengaburkan informasi yang sebelumnya tercatat**. Larangannya adalah menimpa nilai lama tanpa jejak — bukan keharusan menyimpannya sebagai baris transaksi. Audit trail append-only yang menyimpan nilai sebelum dan sesudah secara utuh memenuhi syarat itu sepenuhnya, dan justru merupakan mekanisme yang secara eksplisit disebut standar tersebut.

Sebaliknya, pendekatan versi-sebagai-baris yang dipakai sekarang punya kelemahan kepatuhan yang jarang disadari: ia **hanya menyimpan hasil akhir tiap versi, bukan siapa yang mengubah apa dan mengapa**. Record `REVISED` tidak mencatat aktornya, tidak mencatat alasannya, dan tidak menunjukkan field mana yang berubah. Dari sudut ALCOA+, ia lemah justru di dimensi *Attributable* — dimensi yang paling sering ditanyakan auditor.

Karena itu pilihan ini bukan sekadar menyederhanakan, melainkan **memperkuat** posisi kepatuhan. Yang perlu dijaga adalah audit trail-nya benar-benar memenuhi syarat:

| # | Syarat | Implementasi |
|---|---|---|
| A-1 | **Append-only** | User aplikasi hanya diberi hak `INSERT` dan `SELECT` pada `audit_log`. Tidak ada `UPDATE`/`DELETE`, termasuk untuk Admin aplikasi. Penghapusan hanya mungkin lewat DBA dengan prosedur terpisah. |
| A-2 | **Snapshot utuh** | `before_json` dan `after_json` menyimpan seluruh baris, bukan hanya field yang berubah — agar rekonstruksi tidak bergantung pada rantai entri sebelumnya. |
| A-3 | **Attributable** | `actor_id` sebagai foreign key ke `operator`, bukan string nama bebas. Ini memperbaiki kelemahan nyata aplikasi lama, yang menyimpan `nama_op` dan `approved_by` sebagai teks bebas sehingga akan ambigu bila ada dua operator bernama sama atau ada yang berganti nama. |
| A-4 | **Contemporaneous** | Stempel waktu dihasilkan server dalam UTC (`DEFAULT CURRENT_TIMESTAMP`), tidak pernah dikirim klien — jam perangkat operator tidak dapat dipercaya. |
| A-5 | **Alasan wajib** | Setiap aksi `CORRECT` dan `VOID` menuntut `reason` terisi. Divalidasi di server, bukan sekadar di form. |
| A-6 | **Retrievable & legible** | Setiap record punya panel "Riwayat Perubahan" yang menampilkan seluruh entri berurutan waktu, dapat dicetak/diekspor untuk keperluan audit. Jejak audit yang tidak bisa ditunjukkan sama saja dengan tidak ada. |
| A-7 | **Enduring** | `audit_log` **tidak pernah dihapus otomatis.** Tidak ada job pembersihan, tidak ada pengarsipan berjadwal. Lihat penjelasan di bawah. |
| A-8 | **Available** | `audit_log` termasuk dalam cakupan backup harian (NFR-9) dan diverifikasi dalam uji restore, bukan hanya tabel transaksi. |

**Mengapa pemisahan pra-approval vs `Approved` tetap dipertahankan.** Sekali record disetujui SPV, ia menjadi rekaman yang telah dirilis. Penggantiannya harus terlihat di dalam kumpulan rekaman itu sendiri — seorang auditor yang membaca daftar transaksi harus dapat melihat bahwa suatu record digantikan, tanpa perlu membuka log. Karena itu BR-12 tetap berlaku penuh untuk record `Approved`, dan `audit_log` berperan sebagai lapisan tambahan, bukan pengganti.

Pembagiannya menjadi:

| Status record | Mekanisme | Alasan kepatuhan |
|---|---|---|
| `Pending Approval` · `Rejected` | Edit in-place + `audit_log` | Belum menjadi rekaman terilis; audit trail memenuhi §11.10(e) |
| `Approved` | Reversal + re-entry, **juga** dicatat di `audit_log` | Rekaman terilis; supersession harus terlihat di data, bukan hanya di log |

#### 15.3.2 Retensi Audit Log — Diputuskan: Tidak Dihapus

*Ditetapkan 25 Agustus 2026, menutup D-9.*

Pertanyaan retensi sebelumnya dirumuskan terlalu berbelit. Maksudnya sederhana: **berapa lama catatan "siapa mengubah apa" itu disimpan sebelum boleh dibuang?**

Jawaban yang diambil: **tidak dibuang sama sekali.** Alasannya praktis, bukan teoretis:

**Rekaman mutu yang sesungguhnya adalah form GMP, bukan audit log.** Form itulah yang dicetak, ditandatangani, diarsipkan, dan ditunjukkan kepada auditor. Selama sistem selalu dapat menerbitkan ulang form GMP untuk tanggal berapa pun, kewajiban kepatuhannya sudah terpenuhi. Audit log berperan sebagai **lapisan penjelas** — menjawab "mengapa angka ini pernah berubah" ketika ada yang mempertanyakan — bukan sebagai rekaman utama.

**Karena itu, retensi audit log mengikuti retensi form GMP,** dan bukan aturan tersendiri yang perlu diputuskan terpisah.

**Menyimpannya selamanya lebih murah daripada memikirkannya.** Perkiraan kasar berdasarkan volume nyata:

```
±30 transaksi/hari × ~3 entri log/transaksi × 365 hari  ≈  33.000 baris/tahun
Ukuran ≈ 2 KB/baris (dua snapshot JSON)                 ≈  65 MB/tahun
```

Sekitar 65 MB per tahun. Setelah sepuluh tahun pun masih di bawah 1 GB — lebih kecil daripada satu bulan file export. Merancang, membangun, dan menguji mekanisme pembersihan akan menghabiskan lebih banyak sumber daya daripada yang dihematnya.

**Konsekuensinya:**

- Tidak ada job pembersihan, tidak ada pengarsipan berjadwal, tidak ada parameter retensi yang perlu dikonfigurasi.
- Kemampuan menerbitkan ulang form GMP untuk tanggal berapa pun menjadi **syarat kepatuhan**, bukan sekadar kemudahan — dan itu sudah dijamin FR-12.6 (template form dipilih menurut tanggal data, sehingga form lama terbit dengan revisi yang benar).
- Bila kelak QA menetapkan angka retensi resmi, angka itu tinggal diterapkan tanpa mengubah apa pun dalam rancangan.

### 15.4 WF-3 — Siklus Request Edit

**As-Is.** Empat perjalanan bolak-balik untuk mengubah satu angka pada record yang sudah disetujui:

```
1. Operator  → Request Edit + tulis alasan          status: Approved → Edit Requested
2. SPV       → buka dialog, baca alasan, setujui    status: Edit Requested → Pending Approval
3. Operator  → buka form, koreksi, submit           record lama REVISED, record baru Pending
4. SPV       → approve record baru                  status: Pending → Approved
```

Di antara langkah 2 dan 3, record berada dalam keadaan menggantung: sudah tidak `Approved`, tetapi belum diperbaiki. Bila operator lupa melanjutkan, record itu diam-diam menghilang dari laporan yang menyaring `Approved` — tanpa ada yang tahu.

Selain itu SPV menyetujui **secara buta**: pada langkah 2 ia hanya melihat alasan berupa teks bebas, tidak tahu nilai apa yang akan diubah menjadi berapa.

**To-Be.** Dua langkah, dengan perubahan yang diusulkan menyertai permintaannya:

```
1. Operator  → buka form koreksi, isi nilai baru, ajukan
                → tersimpan sebagai correction_request (PENDING), record asli TETAP Approved
2. SPV       → melihat diff berdampingan "nilai lama → nilai baru", setujui atau tolak
                → disetujui: reversal + re-entry dijalankan server dalam satu transaksi
                → ditolak  : permintaan ditutup, record asli tak tersentuh
```

Perbedaannya bukan sekadar penghematan dua langkah. Yang penting adalah **record asli tidak pernah meninggalkan status `Approved`** sampai penggantinya benar-benar siap. Tidak ada lagi jendela waktu di mana data valid menghilang dari laporan.

Tabel pendukung:

```sql
CREATE TABLE correction_request (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  entity        VARCHAR(40) NOT NULL,       -- receiving | prepast | transfer | monitoring
  entity_id     BIGINT NOT NULL,
  requested_by  BIGINT NOT NULL,
  reason        TEXT NOT NULL,
  payload_json  JSON NOT NULL,              -- field yang diubah beserta nilai barunya
  status        ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  reviewed_by   BIGINT NULL,
  reviewed_at   DATETIME NULL,
  review_note   TEXT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_creq (entity, entity_id, status)
) ENGINE=InnoDB;
```

Status `Edit Requested` menjadi tidak diperlukan lagi pada tabel transaksi, tetapi **tetap dipertahankan di ENUM** demi kompatibilitas data historis hasil migrasi.

**Requirement baru.** `FR-15.1` Request Edit menyertakan nilai yang diusulkan. `FR-15.2` SPV melihat perbandingan lama/baru berdampingan. `FR-15.3` Persetujuan menjalankan koreksi secara otomatis dalam satu transaksi. `FR-15.4` Record asli tetap `Approved` selama permintaan diproses.

**Catatan implementasi (F2-9, selesai 25 Ags 2026).**

| Berkas | Peran |
|---|---|
| `server/src/schemas/koreksi.js` | Bentuk perubahan koreksi, dipakai bersama oleh kedua jalur masuk |
| `server/src/services/permintaanKoreksi.js` | `ajukan`, `daftar`, `setujui`, `tolak` |
| `server/src/routes/permintaanKoreksi.js` | `KOREKSI_AJUKAN` Operator saja, `KOREKSI_TINJAU` SPV saja |
| `client/src/lib/fieldKoreksi.js` | Sumber tunggal peta field di sisi klien |
| `client/src/components/DialogAjukanKoreksi.jsx` | Form pengajuan Operator, berikut ringkasan pra-kirim |
| `client/src/pages/PermintaanKoreksi.jsx` | Panel peninjauan SPV, perbandingan berdampingan |

Empat hal yang muncul saat dikerjakan dan pantas dicatat:

1. **Validasi harus milik service, bukan milik rute.** Skema zod semula berada di
   `routes/koreksi.js`. Begitu jalur masuk kedua lahir (`setujui` memanggil
   `koreksi()` langsung dengan isi `payload_json`), skema itu terlewat: nilai
   dari JSON tetap teks, dan `"1030"` pecah di `hitungQtyLtr` sebagai bukan
   angka. Skemanya karena itu dipindahkan ke `schemas/koreksi.js` dan dipakai
   kedua jalur. Pelajarannya berlaku umum: validasi yang menempel di lapis HTTP
   hanya menjaga pemanggil HTTP.
2. **Pembakuan dilakukan dua kali, dan itu disengaja.** Saat diajukan, supaya
   usulan cacat ditolak di depan pemohon yang masih memegang konteksnya, bukan
   di depan SPV yang tidak dapat memperbaikinya. Saat disetujui, karena
   `payload_json` menyimpan teks apa adanya agar jejak auditnya tetap terbaca
   dan tidak bergeser zona waktu.
3. **Koreksi dijalankan sebelum permintaan ditandai selesai.** Bila koreksinya
   gagal, permintaan tetap `PENDING` dan galatnya sampai ke SPV. Menandai
   selesai lebih dahulu akan membuat SPV mengira perubahan sudah diterapkan
   padahal tidak.
4. **Persetujuan SPV berlaku sebagai konfirmasi rollover** (BR-11). Perbandingan
   yang ia tinjau memuat waktu mulai dan selesai, jadi pergantian hari terlihat
   di sana, bukan tersembunyi di balik satu kotak centang.

**Penjaga yang diuji.** Record harus `Approved` (BR-19); satu permintaan terbuka
per record; usulan wajib benar-benar berbeda dari nilai sekarang; usulan tidak
sah ditolak saat diajukan; alasan wajib saat mengajukan maupun menolak; SPV
tidak dapat mengajukan dan Operator tidak dapat memutuskan (BR-22); permintaan
yang sudah diputuskan tidak dapat diputuskan ulang. Permintaan yang recordnya
berubah setelah diajukan ditandai tidak dapat dijalankan, dan tombol setujuinya
dimatikan sehingga jalan keluarnya hanya penolakan beralasan.

### 15.5 WF-4 — Approval Massal

**As-Is.** SPV membuka `/approval`, memilih satu dari empat tab, lalu menekan ikon centang satu per satu. Setiap klik memicu `Patch` → `Refresh` → `ClearCollect` seluruh koleksi pending, sehingga daftar dirender ulang dan posisi scroll hilang. Pada shift dengan 40 record pending, itu 40 kali render ulang penuh.

Tab juga memaksa SPV berpindah-pindah untuk melihat gambaran utuh, padahal record-record itu saling berkaitan — satu penerimaan, prepast turunannya, dan transfernya biasanya menunggu persetujuan bersamaan.

**To-Be.**

- **Antrean terpadu sebagai tampilan default**, diurutkan waktu, dengan lencana modul per baris. Tab tetap tersedia sebagai filter, bukan sebagai satu-satunya cara melihat.
- **Pilihan jamak** dengan checkbox, "pilih semua di halaman ini", dan satu endpoint `POST /approval/bulk-approve` yang menyetujui seluruh pilihan dalam satu transaksi. Bila ada satu record gagal (mis. ternyata sudah di-void oleh orang lain), seluruh batch dibatalkan dan hasilnya dilaporkan per baris.
- **Pengelompokan berdasarkan rantai** — penerimaan beserta prepast dan transfer turunannya ditampilkan sebagai satu grup yang dapat disetujui sekaligus, sesuai urutan hulu-ke-hilir.
- Persetujuan memperbarui cache secara optimistis; tidak ada render ulang seluruh daftar.

**Dampak.** Waktu approval satu shift turun dari puluhan klik menjadi beberapa klik. Ini adalah perbaikan dengan rasio manfaat-terhadap-risiko tertinggi dalam daftar ini.

**Requirement baru.** `FR-16.1` Antrean approval terpadu lintas modul. `FR-16.2` Pilihan jamak + approve massal transaksional, **terbatas untuk SPV** (BR-22). `FR-16.3` Pengelompokan rantai hulu-hilir. `FR-16.4` Reject tetap satu per satu — penolakan menuntut alasan spesifik.

### 15.6 WF-5 — Dependency Guard yang Buntu

**As-Is.** Operator menekan Edit, mendapat popup WARNING berisi daftar record turunan sebagai teks, lalu satu-satunya tombol yang tersedia adalah **Close**. Ia harus mengingat ID-ID tersebut, menutup popup, berpindah tab, mencari tiap record secara manual, dan mem-void-nya satu per satu — lalu kembali dan mengulangi upaya semula.

Pada rantai dalam (Receiving → 3 Prepast → masing-masing punya Transfer), proses ini bisa memakan belasan langkah navigasi, dan tidak ada indikasi berapa banyak lagi yang tersisa.

**To-Be.** Dialog yang sama, tetapi **dapat ditindaklanjuti**:

```
⚠  RCV-20260825-001 tidak dapat diubah — 3 record turunan aktif

    PST-20260825-004  → SILO 2   5.000 L   Approved     [ Void ]
    PST-20260825-007  → SILO 3   3.000 L   Pending      [ Void ]
      └ TRF-20260825-002 → MT 1  3.000 L   Pending      [ Void ]   ← void ini dulu

    [ Void Semua Turunan ]   [ Batal ]
```

- Pohon dependensi ditampilkan berjenjang, bukan daftar rata, sehingga terlihat mana yang harus ditangani lebih dulu.
- Setiap baris punya aksi void langsung, dinonaktifkan bila ia sendiri punya turunan.
- "Void Semua Turunan" menjalankan cascade dari daun ke akar **dalam satu transaksi**, dengan konfirmasi menyebutkan jumlah record dan total volume yang terdampak.
- BR-15 tidak berubah sedikit pun. Yang berubah adalah operator tidak lagi harus menjadi mesin pencari.

**Risiko.** Void massal adalah operasi merusak. Mitigasi: konfirmasi wajib berisi ringkasan dampak, hak akses terbatas pada SPV, dan setiap baris tercatat di `audit_log` dengan referensi ke aksi induknya.

**Requirement baru.** `FR-17.1` Dependensi ditampilkan sebagai pohon dengan aksi void per baris. `FR-17.2` Cascade void transaksional daun-ke-akar dengan konfirmasi berisi ringkasan dampak. `FR-17.3` Cascade void terbatas untuk SPV.

### 15.7 WF-6 — Menghapus Refresh Manual

**As-Is.** Tujuh layar memiliki ikon refresh yang menjalankan blok identik: `Refresh()` tujuh data source, lalu `ClearCollect()` ulang setiap koleksi, lalu toast "Refresh berhasil dilakukan, tunggu beberapa saat!". Dashboard juga menjalankan seluruh blok itu otomatis lewat Timer berulang.

Kalimat "tunggu beberapa saat" adalah pengakuan jujur bahwa pengguna tidak bisa memastikan data yang dilihatnya mutakhir.

**To-Be.** TanStack Query dengan invalidasi terarah:

- Mutasi apa pun membatalkan hanya query yang terpengaruh (`['silos']`, `['approval','queue']`, dan seterusnya).
- Data dashboard dan antrean approval memakai `refetchInterval` 30 detik dan `refetchOnWindowFocus`.
- Tombol refresh manual dipertahankan hanya di dashboard sebagai jaring pengaman, tanpa toast.
- Data yang sedang dimuat ulang ditampilkan dengan indikator halus, bukan blocking spinner.

**Requirement baru.** `FR-18.1` Data ter-invalidasi otomatis pasca-mutasi. `FR-18.2` Dashboard & antrean approval poll 30 detik. `FR-18.3` Refresh manual hanya di dashboard.

### 15.8 WF-7 — GANTUNG sebagai Status, Bukan Mode

**As-Is.** GANTUNG bekerja lewat tiga mekanisme terpisah: tombol toggle `TANDAI GANTUNG`, kolom boolean `is_gantung`, dan variabel `varCompleteGantung` yang membuka cabang kode khusus di dalam `OnSelect` submit — satu-satunya jalur update in-place di seluruh aplikasi. Operator harus ingat menekan toggle sebelum submit, dan tidak ada daftar terpusat berisi record yang masih menggantung; mereka hanya muncul berlabel `GANTUNG` di antara ratusan baris DataList.

**To-Be.** Perlakukan sebagai status alami, bukan mode:

- Bila field waktu dikosongkan saat submit, sistem **menanyakan** "Simpan sebagai draft tanpa waktu?" — tidak perlu toggle terpisah, dan tidak mungkin lupa menandai.
- Record draft masuk daftar **"Perlu Dilengkapi"** yang tampil sebagai badge di dashboard, sejajar dengan antrean approval.
- Kolom `is_gantung` tetap ada demi kompatibilitas data lama, tetapi turunannya berasal dari `prepast_finish IS NULL` / `trf_time IS NULL`.
- Draft **tidak boleh masuk antrean approval** sampai lengkap. Aturan ini belum ditegakkan di aplikasi lama — record GANTUNG saat ini bisa disetujui SPV dalam keadaan waktunya kosong.

**Requirement baru.** `FR-19.1` Draft terdeteksi otomatis dari waktu kosong, dengan konfirmasi. `FR-19.2` Badge "Perlu Dilengkapi" di dashboard. `FR-19.3` Draft tidak dapat **diajukan maupun disetujui** sampai lengkap (BR-23) — dikonfirmasi 25 Ags 2026.

### 15.9 WF-8 — Navigasi Modul yang Konsisten

**As-Is.** Lima modul, tiga pola navigasi berbeda:

| Modul | Jalur dari dashboard |
|---|---|
| Receiving | Langsung ke form (silo dipaksa `000`) |
| Prepast | Langsung ke form, silo tujuan dipilih di dalam form via dropdown |
| Transfer | Layar pemindai QR → form |
| Monitoring | Layar pemindai QR → form |

Namun layar pemindai QR **juga** menangani modul Receiving dan Prepast (`Switch(varCurrentModule, "Receiving", ..., "Prepast", ...)`), sehingga ada dua jalur berbeda menuju form yang sama, masing-masing dengan validasi berbeda: jalur pemindai memeriksa `is_available`, jalur langsung tidak.

**To-Be.** Satu pola untuk semua: **pilih konteks → isi form**.

- Receiving menampilkan langkah konfirmasi buffer (menampilkan kapasitas tersisa) alih-alih melompatinya diam-diam — operator tetap melihat ke mana susu akan masuk.
- Prepast memakai layar pemilihan silo tujuan yang sama dengan modul lain, bukan dropdown di dalam form.
- Pemindai QR dan dropdown manual selalu tersedia berdampingan di layar pemilihan mana pun.
- Validasi `is_available` berlaku pada satu tempat, sehingga tidak mungkin berbeda antar jalur.

**Requirement baru.** `FR-20.1` Seluruh modul mengikuti pola pilih-konteks-lalu-isi-form. `FR-20.2` Validasi ketersediaan silo terpusat pada langkah pemilihan.

### 15.10 WF-9 s/d WF-13 — Perbaikan Ringkas

**WF-9 — Transfer volume penuh.** Kasus paling umum adalah mengosongkan silo, tetapi operator tetap harus mengetik angka persis dan menunggu FIFO terhitung. Usulan: tombol **"Transfer Semua (12.480 L)"** yang mengisi volume aktual, plus slider untuk transfer sebagian. Alokasi FIFO dihitung live saat nilai berubah (debounce), bukan menunggu `OnChange` blur seperti sekarang. → `FR-21.1`, `FR-21.2`

**WF-10 — Export bulanan. ~~Satu workbook, satu sheet per hari.~~ Direvisi 25 Ags 2026 setelah menganalisa file aslinya.**

Usulan awal keliru. Setiap file bukan lembar rekap, melainkan **dokumen mutu bernomor** (`CMD1/FRM/PRD/01` Rev 02) yang dicetak, ditandatangani operator dan SPV, lalu diarsipkan. Menggabungkan 30 hari menjadi satu workbook merusak sifatnya sebagai rekaman — satu tanda tangan tidak dapat mewakili 30 hari produksi.

Satu file per hari **dipertahankan**. Yang diperbaiki adalah pemborosan di dalamnya: setiap file saat ini membawa 6 sheet padahal hanya 2 yang terisi, sehingga sebulan export berarti mengirimkan template kosong yang sama 30 kali. Dipangkas menjadi 2 sheet (±100 KB → ±20 KB), dan range bulanan dibungkus satu ZIP berisi file harian plus lembar indeks. → `FR-12.8`, `FR-12.12`

Uraian lengkap beserta spesifikasi formatnya ada di **Lampiran C**.

**WF-11 — Monitoring proaktif.** Dashboard sudah menghitung "Perlu dicek! (>4 jam)", tetapi informasi itu berhenti di kartu silo. Operator harus membuka dashboard dan memindai secara visual. Usulan: antrean **"Jatuh Tempo Cek"** yang diurutkan berdasarkan keterlambatan, badge di navigasi, dan notifikasi browser opsional saat silo melewati ambangnya. Aturan ambang (BR-10) tidak berubah — hanya cara penyampaiannya. → `FR-23.1`, `FR-23.2`

**WF-12 — Stock Opname.** Tombol Save saat ini menulis seluruh silo lalu memanggil `Navigate(Scr_SO_Input)` ke layar yang sama, memicu muat ulang penuh. Usulan: simpan per baris saat field kehilangan fokus dengan indikator tersimpan, plus tombol "Finalisasi Periode" terpisah yang mengunci seluruh periode. Memisahkan "menyimpan" dari "mengunci" juga memperbaiki B-3 secara struktural. → `FR-24.1`, `FR-24.2`

**WF-13 — Login.** Dropdown menampilkan nama lengkap seluruh operator aktif kepada siapa pun yang membuka aplikasi. Usulan: input NIK atau pemindaian badge, dengan dropdown sebagai fallback bila operator lupa NIK. Ini juga memperkecil daftar yang harus digulir seiring bertambahnya operator. → `FR-25.1`

### 15.11 Prioritas Implementasi

Usulan di bagian ini **tidak menambah fase**; sebagian besar justru mengurangi pekerjaan bila diputuskan sejak awal, karena mencegah membangun ulang tambalan yang kemudian dibuang.

| Fase | Termasuk | Alasan |
|---|---|---|
| **Fase 0–1** | WF-1, WF-6, WF-8, WF-9, WF-13 | Menyentuh fondasi form & navigasi. Membangunnya dua kali jelas lebih mahal. |
| **Fase 2** | WF-2, WF-3, WF-4, WF-5, WF-7 | Semuanya berada di area tata kelola; menuntut `audit_log` dan `correction_request` yang memang lahir di fase ini. |
| **Fase 3** | WF-10, WF-11, WF-12 | Modul pelengkap, tidak memblokir apa pun. |

Bila cakupan harus dipangkas, **WF-4 (approval massal) dan WF-1 (input waktu) adalah dua yang terakhir dilepas** — keduanya bermanfaat setiap hari bagi setiap pengguna, dengan risiko paling rendah.

---

## 16. Log Keputusan

### 16.1 Sudah Diputuskan

| # | Topik | Keputusan | Tanggal | Dampak PRD |
|---|---|---|---|---|
| **D-1** | Cakupan `FM_Batch_Traceability` | **Di luar cakupan Fase 1.** Modul ini adalah kelanjutan hilir (susu dipakai memproduksi produk apa, menghasilkan batch apa) dan masih berstatus draft; prioritas adalah memantapkan FM Receiving lebih dulu. Data historis tetap dimigrasikan read-only. | 25 Ags 2026 | Bagian 4.3 ditulis ulang · R-4 ditutup · estimasi 13 minggu tetap |
| **D-3** | Jejak audit koreksi (WF-2) | **Pendekatan `audit_log` diadopsi** dengan 8 syarat pengerasan (A-1..A-8). Sesuai 21 CFR Part 11 §11.10(e), ISO 22000 kl. 7.5/8.3, ISO 9001 kl. 7.5.3.2, dan ALCOA+. Pemisahan pra-approval (in-place) vs `Approved` (reversal) dipertahankan. | 25 Ags 2026 | Bagian 15.3.1 baru · skema `audit_log` diperketat · FR-14.1/14.2 dikunci |
| **D-4** | Jalur reject (B-5) | **Bug, diperbaiki.** Reject di Receiving/Prepast/Transfer belum pernah dipakai karena tombolnya tersembunyi, tetapi memang dimaksudkan terpakai. Logikanya sudah ada namun belum pernah dijalankan nyata. | 25 Ags 2026 | Catatan B-5 · risiko R-9 baru · masuk UAT Fase 2 |

| **D-2** | Format export `ExportRekapFM` | **Tertutup.** 20 file Agustus 2026 dianalisa (171 baris penerimaan, 336 penulisan batch). Export ternyata adalah form GMP terkendali `CMD1/FRM/PRD/01` Rev 02, bukan rekap data — spesifikasi lengkap, pemetaan kolom ke field aplikasi, dan aturan agregasi ada di Lampiran C. Menghasilkan FR-12.5..12.14 dan FR-5.10, serta membuka 6 temuan baru (B-15 kemudian dicabut). | 25 Ags 2026 | Lampiran C baru · WF-10 direvisi · Bagian 14.1 baru |
| **D-10** | Kolom "Waktu Penerimaan → Mulai" | **Bukan bug.** Kolom memang ada di form tetapi secara prosedur tidak diisi; pencatatan langsung ke "Waktu Selesai Penerimaan". Kolom dipertahankan kosong di output, tidak ada field input baru. | 25 Ags 2026 | B-15 dicabut · FR-4.2 tidak berubah |
| **D-11** | Agregasi prepast multi-silo | **Tidak ada ambiguitas.** Bila penerimaan terpecah ke beberapa silo, seluruh variabel proses (waktu, flowrate, kedua suhu) **identik** pada setiap pecahan; hanya kolom silo yang digabung dengan pemisah `/`. Nilai yang berbeda antar pecahan diperlakukan sebagai anomali data, bukan kasus agregasi. | 25 Ags 2026 | C.6 diperbarui · aturan konsistensi ditambahkan |
| **D-12** | Cakupan status pada export | **`Pending Approval` dan `Approved` masuk.** Dikecualikan: `Rejected`, `REVISED`, `VOIDED`, `Edit Requested`. Form terbit mengikuti realita operasional harian, tidak menunggu SPV. | 25 Ags 2026 | C.6 diperbarui · memperkuat prioritas WF-3 |
| **D-5** | Peran Admin vs SPV | **Bukan hierarki, melainkan pemisahan wilayah kerja.** Admin: Stock Opname (menetapkan stok awal bulanan), Export, dan manajemen master data. SPV: approval, approve massal, keputusan Request Edit, dan void. Export terbuka untuk keduanya. Admin **tidak** mewarisi wewenang approval maupun void. | 25 Ags 2026 | Matriks peran 2.10.1 baru · BR-22 · FR-26 · temuan B-21 & B-22 |
| **D-6** | Approval massal (WF-4) | **Disetujui**, terbatas untuk SPV. Tidak ada kebijakan yang menuntut peninjauan satu per satu. | 25 Ags 2026 | FR-16.2 dikunci ke SPV |
| **D-7** | Hak cascade void (WF-5) | **Terbatas untuk SPV.** Tidak ada ambang volume tambahan yang disyaratkan; kendalinya berupa konfirmasi berisi ringkasan dampak dan pencatatan penuh di `audit_log`. | 25 Ags 2026 | FR-17.3 dikonfirmasi · BR-22 |
| **D-8** | Draft & approval (WF-7) | **Draft tidak dapat disetujui** karena inputnya belum selesai. Ia juga tidak boleh masuk antrean approval sama sekali sampai dilengkapi. | 25 Ags 2026 | BR-23 baru · FR-19.3 diperkuat |
| **D-9** | Retensi `audit_log` | **Tidak dihapus sama sekali.** Rekaman mutu yang sesungguhnya adalah form GMP yang dicetak & ditandatangani; audit log berperan sebagai lapisan penjelas. Selama form dapat diterbitkan ulang untuk tanggal berapa pun, kewajiban kepatuhan terpenuhi. Volumenya ±65 MB/tahun — membangun mekanisme pembersihan lebih mahal daripada menyimpannya. | 25 Ags 2026 | 15.3.2 baru · A-7 disederhanakan · tidak ada parameter retensi |
| **D-14** | Cakupan input harian Admin | **Admin tidak melakukan input transaksi harian.** Tugas hariannya adalah export data. Satu-satunya input Admin adalah volume awal bulan pada Stock Opname. | 25 Ags 2026 | Matriks 2.10.1 dipersempit |
| **D-15** | Saldo berjalan per silo | **Ditunda ke tahap lanjutan (L-1).** "Jumlah Awal (lt)" bersumber dari Stock Opname, "Saldo (lt)" berjalan mengikutinya. Menutup B-17 dan membuka rekonsiliasi susut. | 25 Ags 2026 | FR-12.10 diturunkan · 12.6 baru |

### 16.2 Masih Terbuka

**Seluruh keputusan terbuka telah tertutup.** Tidak ada pertanyaan tersisa yang memblokir fase mana pun. Dua kemampuan sengaja ditunda ke tahap lanjutan — saldo berjalan (L-1) dan batch traceability (L-2) — keduanya diuraikan di 12.6.

---

## 16A. Alur Pengembalian (BR-25, FR-31)

*Ditetapkan 25 Agustus 2026 atas permintaan pemilik proses.*

### 16A.1 Kejadiannya

Susu yang sudah ditransfer keluar dapat dikembalikan ke silo: produksi berhenti
mendadak, jalur dibersihkan dan sisanya diselamatkan, atau tank perlu
dikosongkan. Volumenya nyata dan harus masuk hitungan stok silo.

Yang membuat alur ini berbeda dari seluruh alur lain: **komposisi suppliernya
tidak dapat dipulihkan.** Di tank maupun jalur pipa, susu dari beberapa
supplier sudah tercampur dan tidak dapat dipisahkan lagi.

### 16A.2 Mengapa ini penting

Sampai sebelum alur ini, sistem memegang satu jaminan: setiap liter di silo
dapat ditelusuri ke supplier lewat rantai penerimaan → prepast → transfer.
Pengembalian **memutus rantai itu**, dan pemutusan tersebut merambat: setiap
batch produksi yang mengambil dari silo berisi volume tak dikenal ikut
kehilangan ketertelusurannya.

Karena itu keputusan rancangannya adalah **menampilkan pemutusan itu, bukan
menambalnya**:

| Yang TIDAK dilakukan | Alasan |
|---|---|
| Membuat supplier semu bernama "PENGEMBALIAN" | Volume tak dikenal akan ikut terhitung di analisa per supplier seolah-olah ia pemasok sungguhan |
| Menebak komposisi secara proporsional dari transfer asal | Menghasilkan angka yang tampak pasti padahal tebakan |
| Menyimpannya di tabel terpisah | Mesin FIFO adalah bagian paling berisiko di sistem ini dan sudah terbukti benar; membuatnya polimorfik demi kerapian model bukan pertukaran yang sepadan |

Sebagai gantinya, `supplier_id` dibiarkan **NULL** — yang berarti "sungguh
tidak diketahui", bukan "belum diisi" — dan `v_silo_volume` mengekspos
`vol_tak_dikenal_ltr` beserta persentasenya per silo.

### 16A.3 Usia susu menentukan urutan pemakaian

Susu yang kembali **bukan susu baru**. Ia sudah dipasteurisasi lebih dulu,
keluar dari silo, dan berada di luar penyimpanan terkendali.

Memberinya kunci FIFO "waktu kembali" akan menempatkannya di **akhir** antrean,
sehingga ia justru dipakai paling akhir. Itu kebalikan dari yang benar, dan
berbahaya karena ia justru susu yang paling berisiko.

Kunci FIFO karena itu diambil menurut urutan kepercayaan:

| Prioritas | Sumber | Keterangan |
|---|---|---|
| 1 | `transfer.trf_time` | Bila transfer asalnya ditautkan |
| 2 | `waktuKeluar` | Diisi operator; ia tahu kapan susu keluar meski tidak tahu suppliernya |
| 3 | `waktuKembali` | Upaya terakhir. Ditandai, dan pengembalian jatuh ke akhir antrean |

Sumber yang dipakai dikembalikan dalam respons dan ditampilkan di UI, sehingga
ketidakpastiannya terlihat alih-alih terkubur dalam satu angka.

### 16A.4 Requirement

| ID | Requirement | Prioritas |
|---|---|---|
| FR-31.1 | Pengembalian menambah volume silo penyimpanan; tidak pernah ke buffer (BR-02) | P0 |
| FR-31.2 | Volume diperiksa terhadap batas keras kapasitas + toleransi (BR-24) | P0 |
| FR-31.3 | `supplier_id` NULL; tidak ada supplier semu | P0 |
| FR-31.4 | Alasan pengembalian **wajib**; tercatat di `audit_log` (syarat A-5) | P0 |
| FR-31.5 | Kunci FIFO menurut prioritas 16A.3; sumbernya dikembalikan | P0 |
| FR-31.6 | Anchor standing time memakai usia susu, bukan waktu kembali (BR-09) | P0 |
| FR-31.7 | `v_silo_volume` mengekspos volume & persentase tak tertelusuri | P0 |
| FR-31.8 | Dashboard menandai silo yang berisi volume tak tertelusuri | P1 |
| FR-31.9 | Pengembalian muncul sebagai modul tersendiri di antrean approval | P0 |
| FR-31.10 | Volume tak tertelusuri ikut ke hilir: transfer yang mengambil darinya mewarisi supplier kosong | P0 |

### 16A.5 Praktik Lapangan: Silo Kosong

*Dikonfirmasi 25 Agustus 2026.*

Susu yang dikembalikan **umumnya dimasukkan ke silo kosong**, supaya tidak
bercampur dengan susu yang ketertelusurannya masih utuh. Setelah itu ia
dipakai langsung, atau dibuang lewat pengosongan silo (tank `PENGOSONGAN SILO`).

Praktik ini menyelesaikan sebagian besar kekhawatiran di 16A.2 secara
prosedural: selama pengembalian berdiri sendiri di silo terpisah,
ketidaktertelusurannya tidak menular ke stok lain.

Sistem mendukung kebiasaan itu alih-alih bersikap netral terhadapnya:

| Perilaku | Alasan |
|---|---|
| Silo kosong diurutkan lebih dulu pada pilihan tujuan | Menjadikan jalur yang benar sebagai jalur termudah |
| Tiap pilihan diberi label `kosong` atau `berisi N L` | Akibat pilihan terlihat sebelum dipilih, bukan sesudah |
| Memilih silo berisi memunculkan peringatan | Kadang itu satu-satunya pilihan; yang penting akibatnya disebutkan |
| **Tidak** diblokir | Memblokir hanya membuat pengembalian tidak tercatat sama sekali |

### 16A.6 Keputusan Tertutup

| # | Topik | Keputusan | Tanggal |
|---|---|---|---|
| **D-16** | Pengembalian pada form GMP | **Tidak perlu kolom sendiri.** Pengembalian dan pindah silo cukup dicatat pada **bagian catatan di bawah blok transfer** Halaman 2. Form `CMD1/FRM/PRD/01` Rev 02 tidak perlu direvisi. | 25 Ags 2026 |
| **D-17** | Ambang volume tak tertelusuri | **Tidak ada ambang, tidak ada pemblokiran.** Sistem menampilkan volume dan persentase tak tertelusuri sebagai informasi; keputusan pemakaian ada pada operator dan SPV. | 25 Ags 2026 |
| **D-18** | Record dengan permintaan koreksi menunggu, pada export | **Tetap diekspor dengan nilai lama, tetapi ditandai di pratinjau.** Export tidak diblokir: menghentikan form harian karena satu permintaan sepele lebih merugikan daripada menerbitkan angka yang sedang diperkarakan. Sebagai gantinya, pratinjau menandai barisnya sebagai **peringatan** (FR-28.5), bukan pemblokir, sehingga Admin tahu sebelum menekan export. | 25 Ags 2026 | FR-28.3 diperluas |

Konsekuensi D-16 untuk FR-12: generator form menuliskan pengembalian dan
pindah silo sebagai **baris catatan di kaki blok transfer**, bukan sebagai
kolom tabel. Ditambahkan sebagai FR-12.15.

---

## 17. Deployment & Lingkungan

**Keputusan (25 Agustus 2026): server on-prem di lingkungan pabrik.**

Pilihan ini tepat untuk sistem produksi yang harus tetap berjalan ketika internet putus — dan itu bukan skenario hipotetis: penerimaan susu berlangsung 24 jam, termasuk saat koneksi keluar sedang terganggu. Konsekuensinya, **tidak boleh ada satu pun jalur kritis yang bergantung pada internet.**

### 17.1 Topologi

```
                      ┌─────────────────────────────┐
   Tablet operator    │  SERVER APLIKASI (on-prem)  │
   (lantai produksi)  │                             │
        │             │  ┌───────────────────────┐  │
        │  WiFi       │  │ Nginx (TLS, port 443) │  │
        ├────────────►│  └───────────┬───────────┘  │
        │             │              │              │
   Desktop SPV/Admin  │  ┌───────────▼───────────┐  │
        │  LAN pabrik │  │ Node.js / Express     │  │
        └────────────►│  │ (2 instance, PM2)     │  │
                      │  └───────────┬───────────┘  │
                      │              │              │
                      │  ┌───────────▼───────────┐  │
                      │  │ MySQL 8 (InnoDB)      │  │
                      │  └───────────┬───────────┘  │
                      │              │              │
                      │  ┌───────────▼───────────┐  │
                      │  │ Volume: backup, export│  │
                      │  └───────────────────────┘  │
                      └──────────────┬──────────────┘
                                     │ (opsional, tidak kritis)
                                     ▼
                          Salinan backup ke NAS / cloud
```

### 17.2 Ketentuan

| ID | Requirement | Prioritas |
|---|---|---|
| NFR-13 | **Tidak ada ketergantungan internet pada jalur kritis.** Seluruh aset — font, ikon, pustaka JS/CSS — disajikan dari server lokal. Tidak ada CDN, tidak ada Google Fonts, tidak ada panggilan API keluar. | P0 |
| NFR-14 | **Sinkronisasi waktu wajib.** Server menjalankan NTP terhadap sumber waktu lokal; bila pabrik punya NTP internal, itu yang dipakai. Deviasi > 5 detik memicu peringatan. Lihat 17.3. | P0 |
| NFR-15 | Aplikasi dikemas sebagai **Docker Compose** — Nginx, Node, MySQL. Deployment dan rollback menjadi satu perintah. | P0 |
| NFR-16 | TLS memakai sertifikat internal pabrik atau CA internal. HTTP dialihkan ke HTTPS. | P0 |
| NFR-17 | Backup MySQL harian otomatis ke volume terpisah, retensi 30 hari, **plus satu salinan di luar server** (NAS atau cloud) | P0 |
| NFR-18 | Uji restore dijalankan **setiap bulan**, hasilnya dicatat. Backup yang belum pernah dipulihkan bukan backup. | P0 |
| NFR-19 | Server terhubung UPS. Mati listrik mendadak tidak boleh merusak basis data — InnoDB dengan `innodb_flush_log_at_trx_commit=1`. | P0 |
| NFR-20 | Health check `/health` memeriksa aplikasi & koneksi database; PM2 merestart otomatis saat proses mati | P0 |
| NFR-21 | Log aplikasi dirotasi harian, retensi 90 hari, tersimpan di volume terpisah dari basis data | P1 |
| NFR-22 | Satu **server cadangan dingin** dengan image dan backup yang sama, agar RTO 4 jam (NFR-9) dapat dipenuhi secara nyata | P1 |

### 17.3 Mengapa Sinkronisasi Waktu Menjadi Syarat P0

Ini bukan kelengkapan administratif. Seluruh sistem bertumpu pada stempel waktu server:

| Bergantung waktu | Akibat bila jam melenceng |
|---|---|
| Urutan FIFO (`prepast_finish` menaik) | **Alokasi ke batch yang salah** — susu lama tertinggal, susu baru terpakai duluan |
| `StandingTimeAnchor` & `standing_time_menit` | Lama berdiri salah hitung — indikator mutu meleset |
| Ambang interval monitoring (BR-10) | Peringatan telat atau prematur |
| Rollover tengah malam (BR-11) | Tanggal transaksi meleset satu hari |
| Syarat *Contemporaneous* audit trail (A-4) | Jejak audit kehilangan nilai pembuktiannya |

Pada server on-prem tanpa internet, jam sistem **melenceng perlahan tanpa ada yang mengoreksi**. Kesalahannya menumpuk diam-diam dan baru ketahuan setelah data historis terlanjur salah. Karena itu NTP lokal, pemantauan deviasi, dan peringatan otomatis adalah syarat, bukan pelengkap.

### 17.4 Spesifikasi Server (Perkiraan)

Diturunkan dari volume nyata: ±30 transaksi/hari, 30 pengguna simultan (NFR-4), 500.000+ baris (NFR-3).

| Komponen | Minimum | Disarankan |
|---|---|---|
| CPU | 4 core | 8 core |
| RAM | 8 GB | 16 GB |
| Disk | 256 GB SSD | 512 GB SSD (RAID 1) |
| OS | Linux LTS | Linux LTS |

Beban aplikasi ini ringan; yang menuntut adalah **keandalan**, bukan kecepatan. RAID 1 dan UPS lebih bernilai daripada CPU tambahan.

### 17.5 Jaringan

| ID | Ketentuan |
|---|---|
| 17.5.1 | Server memiliki alamat IP tetap di LAN pabrik |
| 17.5.2 | Tablet operator mengakses lewat WiFi pabrik; jangkauan WiFi di area penerimaan & silo **diverifikasi sebelum go-live** |
| 17.5.3 | Aplikasi tidak dapat diakses dari luar jaringan pabrik kecuali lewat VPN |
| 17.5.4 | Nama host internal (mis. `fm.cmd1.local`) disiapkan, bukan diakses lewat alamat IP mentah |

> **17.5.2 patut diperiksa lebih awal.** Pemindai QR dan pengiriman form berlangsung di lantai produksi, sering di dekat tangki logam yang meredam sinyal. Titik lemah WiFi baru terasa saat operator gagal menyimpan data di tengah shift — dan itu terlambat.

### 17.6 Yang Tidak Bergantung Internet

Sebagai penegasan atas NFR-13, seluruh fungsi berikut berjalan penuh tanpa koneksi keluar:

```
✅ Login & seluruh input transaksi     ✅ Dashboard & grafik
✅ Approval & void                     ✅ Pemindaian QR (kamera perangkat)
✅ Export form GMP (dihasilkan lokal)  ✅ Manajemen master data
```

Yang **membutuhkan** internet hanyalah salinan backup ke luar (NFR-17) dan notifikasi email opsional (FR-12.4) — keduanya bukan jalur kritis, dan kegagalannya tidak menghentikan operasi.

---

## 18. Strategi Pengujian

Sistem ini memiliki satu sifat yang menentukan cara mengujinya: **bug pada alokasi FIFO dan reversal merusak data secara permanen dan diam-diam.** Tidak ada pesan error, tidak ada layar merah — hanya angka stok yang perlahan menyimpang dari kenyataan fisik. Aplikasi lama tidak pernah punya pengujian otomatis sama sekali.

### 18.1 Prioritas Berdasarkan Akibat Kegagalan

| Lapis | Cakupan | Alasan |
|---|---|---|
| **1 — Kritis** | `allocateFifo()`, reversal, cascade void, standing time | Kegagalan merusak data permanen tanpa terdeteksi |
| **2 — Tinggi** | Transaksi, otorisasi, guard dependensi | Kegagalan merusak integritas atau menembus wewenang |
| **3 — Sedang** | Validasi form, generator export, agregasi dashboard | Kegagalan terlihat dan dapat diperbaiki |
| **4 — Rendah** | Tata letak, tema, animasi | Kegagalan bersifat kosmetik |

### 18.2 Aset Uji yang Sudah Tersedia

Proyek ini punya keuntungan yang jarang ada: **20 hari data produksi nyata beserta keluaran yang sudah diverifikasi manusia** — 20 file export Agustus 2026, berisi 171 penerimaan, 336 transfer, dan ratusan pengecekan monitoring, semuanya sudah ditandatangani operator dan SPV.

Ini menjadi **data uji emas**. Strategi intinya:

```
Data historis SharePoint  ──►  Mesin BARU  ──►  Form GMP hasil sistem
                                                        │
                                                   dibandingkan
                                                        ▼
                                        Form GMP yang sudah ditandatangani
```

Bila mesin baru menghasilkan angka yang berbeda dari form yang sudah ditandatangani, salah satu dari dua hal benar: mesin baru keliru, atau **ia menemukan bug lama** (seperti B-16, B-17, dan B-19 yang sudah terbukti). Setiap selisih ditelusuri sampai tuntas dan diputuskan — tidak ada yang diabaikan.

| ID | Requirement | Prioritas |
|---|---|---|
| T-1 | Ke-20 file export dijadikan berkas uji emas dalam repositori | P0 |
| T-2 | Uji replay menjalankan data historis lewat mesin baru dan membandingkan keluarannya sel demi sel | P0 |
| T-3 | Setiap selisih ditelusuri dan diklasifikasikan: bug baru, bug lama yang ditemukan, atau perbedaan yang disengaja | P0 |
| T-4 | Perbedaan yang disengaja dicatat sebagai daftar pengecualian beserta alasannya | P0 |

### 18.3 Pengujian Unit — Lapis Kritis

`allocateFifo()` ditulis sebagai **fungsi murni tanpa I/O**, justru agar dapat diuji habis-habisan.

| ID | Kasus uji | Harapan |
|---|---|---|
| T-5.1 | Volume tepat sama dengan satu batch | Satu alokasi, batch tertutup |
| T-5.2 | Volume melintasi beberapa batch | Alokasi berurutan FIFO, batch terakhir sebagian |
| T-5.3 | Volume melebihi total tersedia | Sisa > 0, submit ditolak (BR-05) |
| T-5.4 | Volume nol atau negatif | Ditolak |
| T-5.5 | Silo kosong | Alokasi kosong, ditolak |
| T-5.6 | Batch bersisa nol ikut dalam daftar | Dilewati, tidak menghasilkan alokasi nol |
| T-5.7 | Dua batch berwaktu `prepast_finish` identik | Urutan deterministik (pemecah seri: `id`) |
| T-5.8 | Pecahan desimal | Tidak ada liter yang hilang akibat pembulatan |
| T-5.9 | Alokasi dari 20 hari data nyata | Sama persis dengan `supplier_fifo` historis |

**T-5.7 dan T-5.8 patut diperhatikan.** Aplikasi lama tidak menetapkan pemecah seri ketika dua batch punya waktu selesai sama — urutannya bergantung pada urutan pengembalian SharePoint, yang tidak dijamin. Dan pembulatan yang tidak konsisten dapat menghilangkan atau menciptakan liter dari ketiadaan.

| ID | Cakupan uji unit lain | Prioritas |
|---|---|---|
| T-6 | Reversal: kembalikan alokasi → verifikasi jumlah total kekal | P0 |
| T-7 | Cascade void: void bertingkat → verifikasi jumlah total kekal | P0 |
| T-8 | Standing time: set · reset · warisan penuh · warisan sebagian (BR-09) | P0 |
| T-9 | Rollover tengah malam pada prepast & transfer (BR-11) | P0 |
| T-10 | Konversi kg→liter, pembulatan ke bawah (BR-03) | P0 |
| T-11 | Normalisasi batch ke bentuk kanonik (BR-21) | P0 |

**Aturan kekekalan** yang berlaku pada T-6, T-7, dan setiap uji transaksi:

```
Σ volume di seluruh sistem sebelum operasi  ==  Σ sesudah operasi
```

Liter tidak boleh tercipta maupun lenyap. Ini invarian paling kuat yang dimiliki sistem ini, dan diperiksa setelah **setiap** operasi tulis dalam pengujian.

### 18.4 Pengujian Integrasi

| ID | Skenario | Harapan | Prioritas |
|---|---|---|---|
| T-12 | Submit transfer gagal di tengah | Rollback penuh, tidak ada perubahan tersisa (M-1) | P0 |
| T-13 | **Dua transfer bersamaan dari silo sama** | Satu berhasil, satu ditolak atau menunggu; tidak ada over-allocation (M-5) | P0 |
| T-14 | Dua koreksi bersamaan atas record sama | Tidak ada reversal ganda | P0 |
| T-15 | Guard dependensi memblokir edit, void, dan reject (BR-15) | Ketiganya terblokir konsisten | P0 |
| T-16 | Wewenang ditegakkan di endpoint, **bukan hanya di UI** (B-22) | Operator memanggil endpoint approval → ditolak 403 | P0 |
| T-17 | Draft tidak dapat diajukan maupun disetujui (BR-23) | Ditolak | P0 |
| T-18 | Idempotency: submit ganda akibat koneksi terputus (NFR-10) | Hanya satu record tercipta | P0 |
| T-19 | Prepast multi-silo: satu baris gagal (FR-29.6) | Tidak ada baris yang tersimpan | P0 |

**T-13 adalah pengujian terpenting di seluruh daftar.** Ia menguji hal yang sama sekali tidak mungkin dijamin oleh aplikasi lama. Jalankan dengan dua permintaan yang benar-benar bersamaan, bukan berurutan.

**T-16 juga wajib.** Otorisasi aplikasi lama hanya berupa properti `Visible` pada tombol; pengujian harus memanggil endpoint secara langsung, melewati UI sepenuhnya.

**Catatan implementasi (F2-13, 25 Ags 2026).** Basis uji berdatabase ada di
`server/test/bantuan/dbUji.js`, dijalankan lewat `npm run test:integrasi`.
Empat keputusan yang membentuknya:

| Keputusan | Alasan |
|---|---|
| Basis data uji terpisah, `fm_receiving_test` | `reset()` meng-TRUNCATE seluruh tabel transaksi. Satu variabel lingkungan yang lupa diset sudah cukup untuk mengarahkannya ke data kerja. Nama WAJIB berakhiran `_test`, diperiksa sebelum apa pun disentuh. |
| Dibangun ulang penuh per proses uji | Setiap berkas uji mendapat skema bersih, jadi hasilnya tidak bergantung pada urutan berkas. |
| Dibersihkan di AWAL tiap uji, bukan di akhir | Uji yang gagal di tengah meninggalkan sisa. Membersihkan di akhir membuat kegagalan pertama merembet menjadi kegagalan palsu berikutnya. |
| Berjalan berurutan (`--test-concurrency=1`) | Beberapa berkas uji berebut satu basis data; paralel menghasilkan `database exists` yang menyesatkan. Basis data adalah sumber daya bersama, jadi ujinya memang serial. |

**Model hak akses ikut teruji, bukan dilewati.** `005_grants.sql` menyebut nama
basis data secara harfiah karena GRANT tidak menerima nama dinamis, jadi
namanya disubstitusi untuk basis data uji. Percobaan pertama memakai pool
aplikasi untuk membersihkan ditolak dengan "DROP command denied" - dan
penolakan itu BENAR: `fm_app` sengaja tidak memiliki hak DROP. Yang mengalah
adalah perkakasnya, bukan hak aksesnya; melonggarkan hak agar ujinya lolos
berarti menguji sistem yang berbeda dari yang dijalankan.

> **Temuan: wewenang hanya ditegakkan di lapis rute.** Uji T-16 yang memanggil
> service secara langsung menemukan bahwa `void`, `approval`, dan
> `permintaanKoreksi` mengandalkan sepenuhnya middleware rute; hanya
> `koreksi.js` memeriksa peran sendiri (BR-19). Itu sesuai rumusan awal
> ("wewenang diperiksa di endpoint, bukan di UI") dan sudah jauh lebih kuat
> daripada properti `Visible` milik B-22. Tetapi penjagaan satu lapis berlaku
> hanya bagi pemanggil yang melewati lapis itu, dan proyek ini sudah dua kali
> tersandung pola yang sama pada hari yang sama: skema zod di lapis rute yang
> dilewati alur persetujuan permintaan koreksi (F2-9), dan penjaga dedupe di
> lapis api yang dilewati pemulih sesi (F2-12). Karena approval dan void adalah
> keputusan mutu yang tidak dapat dibatalkan, `pastikanBerwenang()` kini
> dipanggil tepat di tempat keputusan diambil. Middleware rute tetap menjadi
> gerbang pertama.

**Cakupan sekarang.** 24 uji integrasi meliputi BR-03 (FLOOR), BR-06 (sisa
batch induk), FR-29.7 & BR-24 (kapasitas per silo dan batas kerasnya, termasuk
kasus toleransi terhitung dua kali), kekekalan volume pada prepast dan pada
cascade void (BR-14, T-29), BR-15 (guard dependensi beserta pohon
penghalangnya), BR-19 & BR-22 (matriks peran, Admin bukan superset SPV),
BR-23 (draft), FR-15 seluruh jalurnya, dan jejak audit A-6. Ditambah 155 uji
unit, seluruhnya 179.

**Belum tertutup.** T-13 (dua transfer benar-benar bersamaan dari silo yang
sama) dan T-18 (idempotency saat koneksi terputus) menuntut permintaan yang
sungguh paralel, bukan berurutan, sehingga perlu penggerak uji yang berbeda.
T-13 adalah uji terpenting di seluruh daftar dan masih terbuka.

### 18.5 Pengujian Migrasi

Kriteria V-1 s/d V-6 (11.3) dijalankan sebagai pengujian otomatis, bukan pemeriksaan manual sekali jalan.

| ID | Requirement | Prioritas |
|---|---|---|
| T-20 | V-1..V-6 berjalan otomatis setiap kali migrasi dijalankan | P0 |
| T-21 | Dry run pada salinan penuh data produksi, minimal tiga kali sebelum cutover | P0 |
| T-22 | Laporan pengecualian ditinjau dan disetujui sebelum cutover | P0 |
| T-23 | Migrasi bersifat **idempoten** — dijalankan dua kali menghasilkan keadaan yang sama | P0 |

### 18.6 UAT

| ID | Peran | Skenario | Prioritas |
|---|---|---|---|
| T-24 | Operator | Alur harian penuh: login → terima → prepast multi-silo → monitoring ronde → transfer | P0 |
| T-25 | Operator | Salah input → koreksi → submit ulang | P0 |
| T-26 | Operator | Simpan draft → lengkapi keesokan hari | P0 |
| T-27 | SPV | Approve massal → reject beralasan → tinjau Request Edit | P0 |
| T-28 | SPV | **Reject di keempat modul** — jalur yang belum pernah dipakai di produksi (R-9) | P0 |
| T-29 | SPV | Cascade void dengan rantai berlapis | P0 |
| T-30 | Admin | Stock Opname bulanan → export harian → kelola master data | P0 |
| T-31 | Semua | Pratinjau form GMP, temukan masalah, perbaiki, export ulang | P0 |
| T-32 | Semua | Uji di tablet sungguhan, di lantai produksi, dengan WiFi sungguhan (17.5.2) | P0 |

**T-28 menuntut perhatian khusus.** Jalur reject di modul Receiving, Prepast, dan Transfer belum pernah dijalankan sekali pun di produksi. Guard dependensi BR-15 pada jalur itu juga belum pernah aktif. Uji seluruh rantainya: reject → status `Rejected` → koreksi operator → submit ulang → approve.

**T-32 tidak dapat digantikan pengujian di meja.** Sarung tangan basah, layar tersorot lampu pabrik, WiFi lemah dekat tangki logam — ketiganya hanya muncul di tempat kerjanya.

### 18.7 Regresi

| ID | Requirement | Prioritas |
|---|---|---|
| T-33 | **Setiap business rule BR-01..BR-25 memiliki minimal satu uji otomatis** yang menyebut nomor aturannya | P0 |
| T-34 | Setiap bug B-1..B-22 yang diperbaiki memiliki uji yang gagal sebelum perbaikan | P0 |
| T-35 | Seluruh rangkaian uji berjalan di CI pada setiap perubahan | P0 |
| T-36 | Cakupan uji lapis kritis (18.1) minimal 90% | P0 |

**T-33 mengubah katalog business rule menjadi jaring pengaman yang hidup.** Ketika seseorang kelak mengubah logika FIFO tanpa memahami BR-04, uji yang menyebut `BR-04` akan gagal dan menjelaskan aturan mana yang dilanggar — bukan sekadar melaporkan angka yang tidak cocok.

### 18.8 Yang Tidak Diuji Otomatis

Disebutkan secara terbuka agar tidak disangka terlewat: tata letak visual, warna, dan animasi diperiksa manual. Kesetiaan tata letak form GMP diperiksa dengan **membandingkan hasil cetak berdampingan** dengan form asli — perbedaan satu baris atau satu merge terlihat oleh mata, tetapi mahal untuk diuji otomatis.

---

## Lampiran A — Peta Screen → Route

| Screen Power Apps | Route Web | Akses |
|---|---|---|
| `Scr_Login` | `/login` | Publik |
| `Scr_Home` | `/` | Semua |
| `Scr_QRScan_Silo` | `/scan/silo?module=` | Semua |
| `Scr_QRScan_Tank` | `/scan/tank` | Semua |
| `Scr_Receiving_Input` | `/receiving/new` · `/receiving/:id/correct` | Semua |
| `Scr_Prepast_Input` | `/prepast/new` · `/prepast/:id/correct` · `/prepast/:id/complete` | Semua |
| `Scr_Transfer_Input` | `/transfer/new` · `/transfer/:id/correct` · `/transfer/:id/complete` | Semua |
| `Scr_Monitoring_Input` | `/monitoring/new` · `/monitoring/:id/correct` | Semua |
| `Scr_SO_Input` | `/stock-opname` | **Admin** |
| `Scr_Approval` | `/approval?tab=` | **SPV** |
| `Scr_DataList` | `/data?tab=` | Semua |
| `Scr_Detail` | `/silo/:id` | Semua |
| `Scr_Export` | `/export` | SPV, Admin |
| *(baru)* | `/admin/master/*` | **Admin** — FR-26 |

## Lampiran B — Peta Variabel Global → State Klien

| Variabel Power Apps | Padanan Web |
|---|---|
| `varCurrentUser`, `varIsLoggedIn`, `varIsSpv`, `varIsAdmin` | `AuthContext` (klaim JWT) |
| `varSessionValid` | Route guard |
| `varCurrentModule` | Query param pada route pemindai |
| `varSelectedSilo`, `varSelectedTank`, `varSelectedSiloTarget` | State form (react-hook-form) |
| `varCorrectionSource`, `varIsCorrection` | Param route + data yang di-fetch |
| `varCompleteGantung` | Route terpisah `/complete` |
| `varFifoCalculated`, `colFifoAllocation`, `varRemainingVol` | Respons `GET /transfer/fifo-preview` |
| `varTfReversalDone`, `varTransferReturnFlag`, `varPrepastReturnFlag` | **Dihapus** — flag ini menambal ketiadaan transaksi; server menanganinya |
| `colSiloMaster`, `colSupplierMaster`, `colOperatorMaster`, `colTankMaster` | Cache TanStack Query |
| `colPending*`, `colAll*`, `colDetail*` | Query berpaginasi per halaman |
| `varShowRejectDialog`, `varShowVoidPopup`, `varShowEditWarning`, `varShowRequestEditPopup` | State dialog lokal |

---

## Lampiran C — Spesifikasi Form Export GMP

*Disusun dari analisa 20 file `Rekap_FM_2026MMDD.xlsx` (Agustus 2026, 171 baris penerimaan) yang dilampirkan 25 Agustus 2026. Menutup keputusan D-2.*

### C.1 Temuan Utama: Export Adalah Catatan Mutu, Bukan Laporan

Asumsi awal PRD keliru dalam satu hal penting. Export ini **bukan** rekap data untuk analisa — ia adalah **form terkendali sistem mutu yang diisi otomatis**:

```
PT CISARUA MOUNTAIN DAIRY TBK / PLANT SENTUL 1
FORM — Penerimaan, Pre-Pasteurisasi, Pemakaian dan Monitoring Susu Segar

No. Dokumen : CMD1/FRM/PRD/01        Revisi  : 02
Berlaku     : 11 Maret 2025          Halaman : 1 dari 2
```

Konsekuensinya mengubah cakupan FR-12 secara mendasar:

- File ini adalah **rekaman mutu** (ISO 22000 kl. 7.5), bukan output analitik. Ia dicetak, ditandatangani, dan diarsipkan.
- **Nomor dokumen, nomor revisi, dan tanggal berlaku harus menjadi data terkelola**, bukan teks yang tertanam di template. Ketika QA menerbitkan Revisi 03, sistem harus dapat mengikuti tanpa menyentuh kode.
- Setiap file menyediakan **dua blok tanda tangan**: kolom "Paraf" per baris operator di Halaman 1, dan "Diperiksa Oleh — Spv Produksi Shift 1 / 2 / 3" di kaki Halaman 2.
- Tata letak **tidak boleh diubah sepihak** oleh tim pengembang. Perubahan format form menuntut persetujuan QA melalui prosedur pengendalian dokumen.

### C.2 Struktur Workbook

Setiap file berisi **6 sheet**, namun hanya 2 yang diisi:

| Sheet | Revisi | Isi | Peran |
|---|---|---|---|
| `Hal 1` | 00 (10 Juni 2023) | kosong | Template lama, ikut terbawa |
| `Hal 2` | 00 | kosong | Template lama, ikut terbawa |
| **`Receiving_Prepast`** | **02 (11 Maret 2025)** | **terisi** | **Halaman 1 — output nyata** |
| **`Monitoring_Transfer`** | **02** | **terisi** | **Halaman 2 — output nyata** |
| `Hal 1 Rev 3` | 02 | kosong | Template bersih |
| `Hal 2 Rev 3` | 02 | kosong | Template bersih |

Empat dari enam sheet adalah bagasi. Pada ukuran ±100 KB per file, satu bulan export berarti mengirimkan template kosong yang sama sebanyak 30 kali. Ini diperbaiki di WF-10.

### C.3 Halaman 1 — `Receiving_Prepast`

Satu baris = satu penerimaan beserta prepast turunannya. Baris data mulai **r10**, kapasitas **17 baris** (r10–r26). Header tabel di r7–r9 dengan merge bertingkat dua level.

| Kol | Header L1 | Header L2 | Sumber di aplikasi | Kolom MySQL | Format |
|---|---|---|---|---|---|
| A | No. | | nomor urut tampilan | — | `General`, int |
| B | Supplier FM | | `ddSupplier.Selected.supplier_name` | `supplier.supplier_name` | teks |
| C | Waktu Penerimaan | Mulai | **TIDAK ADA** — lihat B-15 | *(perlu field baru)* | `h:mm` |
| D | Waktu Penerimaan | Selesai | `finish_time` | `receiving.finish_time` | `h:mm` |
| E | Jumlah | Kg | `txtQtyKg` | `receiving.qty_kg` | `General`, int |
| F | Jumlah | BJ | `txtBeratJenis` | `receiving.berat_jenis` | `General`, 3 desimal |
| G | Jumlah | TS | `txtNilaiTS` | `receiving.nilai_ts` | `General`, 1 desimal |
| H | Jumlah | Lt | terhitung `FLOOR(kg/bj)` | `receiving.qty_ltr` | `General`, int |
| I | Data Prepasteurisasi | Mulai | `prepast_start` | `prepast_record.prepast_start` | `h:mm` |
| J | Data Prepasteurisasi | Selesai | `prepast_finish` | `prepast_record.prepast_finish` | `h:mm` |
| K | Flowrate Prepasteurisasi | | `txtFlowratePrp` | `prepast_record.flowrate_pst` | `General`, 1 desimal |
| L | T.04 Temp After Heater (OPRP)\*) | | `txtTempAftHeater` | `prepast_record.temp_after_heater` | `General`, 1 desimal |
| M | Temperatur Output Produk | | `txtTempOutput` | `prepast_record.temp_output_prd` | `General` |
| N | Disimpan di Silo No: | | gabungan silo tujuan | *(agregat, lihat C.6)* | teks |
| O | Dikerjakan Oleh | Nama | `varCurrentUser.nama_lengkap` | `operator.nama_lengkap` | teks |
| P | Dikerjakan Oleh | Paraf | — | — | kosong (tanda tangan basah) |

**Catatan kaki (r27):** `*) Setting Temp. : 90oC, Min Temp. : 81oC` — terkait kolom L yang ditandai **OPRP** (*Operational Prerequisite Programme*, ISO 22000). Nilai kolom ini adalah titik kendali keamanan pangan, bukan sekadar data proses. Batas 81 °C berimplikasi pada FR-5: **sistem seharusnya memvalidasi `temp_after_heater ≥ 81`**, yang saat ini tidak dilakukan sama sekali.

Verifikasi kalkulasi terhadap data nyata mengonfirmasi BR-03: `20296 / 1,025 = 19800,0 → 19800` ✓ (pembulatan ke bawah).

### C.4 Halaman 2 — `Monitoring_Transfer`

Halaman ini **ter-pivot**, dan inilah bagian tersulit dari implementasi export.

**Blok 1 — Monitoring (r8–r18).** Grid silo × interval:

- Kolom A: label interval `4 jam I` … `4 jam VII` (7 baris, r10–r16)
- 8 silo tetap (1, 2, 3, 4, 5, 6, 25A, 25B), masing-masing 3 kolom: `Jam` · `Suhu (oC)` · `pH`
- Kolom B–Y, dengan merge nama silo di r8 melintasi 3 kolom
- r18: `Nama & Paraf Operator` per silo

Silo 25A dan 25B memakai header `Jam*)` (dengan asterisk), sementara silo lain memakai `Jam` — form itu sendiri mengakui bahwa dua silo tersebut punya aturan interval berbeda, sejalan dengan BR-10.

**Blok 2 — Data Pemakaian Susu / Transfer (r19–r43).** Blok 3 baris per silo:

| Baris | Silo | | Baris | Silo |
|---|---|---|---|---|
| r21–r23 | Silo 1 | | r33–r35 | Silo 5 |
| r24–r26 | Silo 2 | | r36–r38 | Silo 6 |
| r27–r29 | Silo 3 | | r39–r41 | Silo 25A |
| r30–r32 | Silo 4 | | r42–r44 | Silo 25B |

Tata letak kolom per baris:

```
A: nama silo
B–C: Jumlah Awal (lt)          ← stock opname, TIDAK PERNAH TERISI (B-17)
D,E,F   : Jam Transfer | Batch | Volume (lt)   ← slot 1
G,H,I   : slot 2      J,K,L : slot 3      M,N,O : slot 4
P,Q,R   : slot 5      S,T,U : slot 6      V,W,X : slot 7
Y: Saldo (lt)                  ← TIDAK PERNAH TERISI
```

**Kapasitas 7 transfer per baris × 3 baris = 21 transfer per silo per hari.** Luapan mengalir ke baris berikutnya dalam blok yang sama — terlihat nyata pada 6 Agustus, di mana Silo 25A memakai r39 dan r40, serta Silo 25B memakai r42 dan r43. Slot yang tidak terpakai diisi `0`, bukan dikosongkan.

**Kaki (r46):** `Diperiksa Oleh, Spv Produksi Shift 1 / 2 / 3 :` — blok tanda tangan SPV.

### C.5 Cacat yang Ditemukan pada Output Export

Analisa 20 file mengungkap enam cacat yang **tidak terlihat dari kode aplikasi saja**. Semuanya ditambahkan ke katalog bug utama sebagai B-15 s/d B-20.

#### ~~B-15~~ — Kolom "Waktu Penerimaan → Mulai": **bukan bug, memang tidak diisi**

*Dikonfirmasi 25 Agustus 2026 — dicabut dari katalog bug.*

Kolom "Mulai" memang ada di form GMP tetapi **secara prosedur tidak diisi**; pencatatan langsung ke "Waktu Selesai Penerimaan". Kosongnya kolom C di seluruh 171 baris adalah perilaku yang benar, bukan cacat.

Yang tetap berlaku:

- **Kolom C dipertahankan kosong** di output export. Tata letak form tidak berubah, dan tidak ada field input baru yang ditambahkan ke FR-4.2.
- **B-11 tetap berdiri sebagai temuan skema.** Kolom SharePoint bernama internal `start_time` dengan nama tampilan `finish_time` tetap membingungkan dan tetap diperbaiki saat migrasi menjadi satu kolom bernama jelas `receiving.finish_time`. Penamaan `start_time` kemungkinan adalah sisa dari rancangan awal ketika kolom "Mulai" masih dimaksudkan untuk diisi.
- Karena hanya satu stempel waktu yang dicatat, **tidak ada durasi penerimaan yang dapat dihitung**. Bila suatu saat metrik itu dibutuhkan, barulah kolom "Mulai" perlu diaktifkan — dan itu menuntut revisi dokumen QA.

#### B-16 — Tanggal form tertukar hari/bulan pada tanggal 1–12

Cacat paling serius yang ditemukan. Pemeriksaan sel `C6` (Hari/Tanggal) di seluruh 20 file:

| Tanggal file | Isi sel `C6` | Tipe | Status |
|---|---|---|---|
| 2026-08-01 | `2026-01-08` | DATETIME | **salah — tertulis 8 Januari** |
| 2026-08-06 | `2026-06-08` | DATETIME | **salah — tertulis 8 Juni** |
| 2026-08-12 | `2026-12-08` | DATETIME | **salah — tertulis 8 Desember** |
| 2026-08-13 | `"13/08/2026"` | TEKS | benar, tapi tersimpan sebagai teks |
| 2026-08-24 | `"24/08/2026"` | TEKS | benar, tapi tersimpan sebagai teks |

Polanya jelas: nilai ditulis sebagai string `dd/mm/yyyy` lalu ditafsirkan Excel sebagai `mm/dd/yyyy`. Untuk tanggal 1–12, penafsiran itu "berhasil" dan menghasilkan tanggal yang salah. Untuk tanggal 13–31, angka harinya tidak mungkin menjadi bulan, sehingga tetap tersimpan sebagai teks — kebetulan yang justru menyelamatkan.

**12 dari setiap 30 form membawa tanggal yang salah**, dan 18 sisanya membawa tanggal bertipe teks yang tidak dapat diurutkan atau difilter. Pada dokumen mutu yang ditandatangani dan diarsipkan, ini temuan audit yang serius.

Akar masalahnya sama dengan M-3 — waktu yang diperlakukan sebagai string — dan hilang dengan sendirinya begitu tanggal ditulis sebagai nilai bertipe `date` dengan `number_format` eksplisit `dd/mm/yyyy`.

#### B-17 — "Jumlah Awal (lt)" dan "Saldo (lt)" tidak pernah terisi

Kosong di seluruh 20 file, untuk kedelapan silo. Kolom "Jumlah Awal" seharusnya diisi dari modul Stock Opname. Ini adalah **bukti lapangan yang mengonfirmasi B-2**: logika upsert Stock Opname memang rusak, sehingga datanya tidak pernah tersimpan dan karenanya tidak pernah muncul di form.

Kolom "Saldo (lt)" tidak punya sumber sama sekali di aplikasi. Secara logika ia adalah `Jumlah Awal + total prepast masuk − total transfer keluar` — nilai yang setelah migrasi dapat dihitung langsung dari `v_silo_volume`.

#### B-18 — Nilai "Disimpan di Silo No" tidak dinormalisasi

Ditemukan 32 nilai unik dari kombinasi 8 silo, karena satu penerimaan dapat terpecah ke beberapa silo dan export menggabungkannya dengan pemisah `/`:

```
SILO25A · SILO25A/25B · SILO25B/1/3/25A · SILO2/3/1 · SILO6/25A
```

Dua di antaranya menunjukkan cacat: **`SILO25A/25A`** dan **`SILO6/6/25A`** — silo yang sama muncul dua kali karena penggabungan tidak melakukan deduplikasi. Terjadi ketika satu penerimaan menghasilkan dua record prepast ke silo tujuan yang sama.

#### B-19 — Nama silo kemungkinan tidak konsisten, membuat BR-10 tidak pernah aktif

Ini temuan berantai dan berpotensi berdampak besar.

Export menuliskan `prepast.silo_tujuan_display` — yang di aplikasi berasal dari `ddSiloTujuan.Selected.silo_name.Value` — dan nilainya konsisten **tanpa spasi**: `SILO25A`, `SILO25B`, `SILO1`.

Namun `Scr_Home` menentukan ambang interval monitoring dengan perbandingan **memakai spasi**:

```
intJam: If(
    ThisItem.silo_name.Value = "SILO 25A" || ThisItem.silo_name.Value = "SILO 25B",
    2, 4
)
```

Bila `silo_name.Value` sesungguhnya bernilai `"SILO25A"`, perbandingan itu **tidak pernah bernilai benar**, dan ambang selalu jatuh ke 4 jam. Artinya BR-10 — aturan 2 jam untuk kedua silo tersebut — kemungkinan besar tidak pernah aktif sejak awal.

Data monitoring justru memperkuat dugaan ini. Pada 6 Agustus, Silo 25A dicek pukul 08, 10, 12, 14, 19, 21, 23 — **interval 2 jam**. Operator menjalankan aturannya dengan benar, tetapi peringatan "Perlu dicek!" di dashboard tidak pernah menyala tepat waktu untuk silo-silo tersebut.

> **Verifikasi yang dibutuhkan:** periksa nilai sesungguhnya kolom `silo_name` di `Silo_Master`. Bila benar tanpa spasi, ini bug produksi aktif yang layak diperbaiki di aplikasi Power Apps **sekarang**, tidak menunggu migrasi. Setelah migrasi, ambang menjadi kolom `silo.monitoring_interval_jam` sehingga tidak lagi bergantung pada pencocokan string.

#### B-20 — Batch number tanpa normalisasi

Terkumpul **139 nilai batch unik dari 336 penulisan** selama 20 hari. Konvensi yang berlaku dikonfirmasi 25 Agustus 2026:

| Tujuan transfer | Format batch |
|---|---|
| Tank **CMD 2** | `CMD2` |
| Tank **MT** tertentu | Prefiks jenis + nomor urut batch — `HC1`, `HC2`, `HC3`, `FC1`, `FC2`, … |
| **PINDAH SILO** | Dihasilkan sistem: `TF TO <silo>` |

Membandingkan konvensi itu terhadap data nyata memperlihatkan bahwa **penulisan sesungguhnya menyimpang dalam tiga hal**:

| Prefiks | Jumlah | Status terhadap konvensi |
|---|---|---|
| `CMD` | 104× | ✅ sesuai |
| `HRC` | 97× | ⚠️ ditulis **HRC**, bukan `HC` |
| `FC` | 57× | ✅ prefiksnya sesuai |
| `INK` / `INKUBASI` | 52× | ❌ **tidak disebut dalam konvensi** |
| `TF TO SILOx` | 13× | ✅ dihasilkan sistem |
| `FULLFM` | 4× | ❌ tidak disebut |
| `SR` | 2× | ❌ tidak disebut |
| `7437` | 1× | ❌ jelas salah input |

Tiga penyimpangan yang perlu diselesaikan:

**1. `HRC` versus `HC`.** Konvensi menyebut `HC`, tetapi 97 dari 336 penulisan memakai `HRC`, dan tidak satu pun memakai `HC` polos. Kemungkinan besar `HRC` adalah bentuk yang sebenarnya dipakai di lapangan.

**2. Posisi angka tidak konsisten.** Konvensi menempatkan angka **setelah** huruf (`HC1`), tetapi data terbelah hampir merata:

```
angka dulu  : 1HRC · 10hrc · 2FC · 3 fc      →  55× HRC, 52× FC, 35× INK
huruf dulu  : HRC1 · FC2 · INK3              →  42× HRC,  5× FC, 15× INK
```

Keduanya merujuk batch yang sama. Tanpa satu bentuk baku, `1HRC` dan `HRC1` akan terhitung sebagai dua batch berbeda.

**3. Ada jenis batch di luar konvensi.** `INK`/`INKUBASI` muncul 52 kali — lebih sering daripada `FC` — namun tidak disebutkan sama sekali. Begitu pula `FULLFM` dan `SR`. Varian seperti `B.13INK`, `B 9 INK`, `11ink 240ml`, dan `13 ink (FullFm)` menunjukkan operator menambahkan keterangan produk ke dalam field batch.

Di atas ketiganya menumpuk masalah penulisan bebas: huruf besar-kecil campur, spasi di akhir, spasi di tengah, dan nol di depan yang tidak konsisten (`1HRC` · `1hrc` · `01hrc` · `1HRC `).

**Mengapa ini penting.** Batch adalah **satu-satunya kunci penghubung ke `FM_Batch_Traceability`** (D-1). Menelusuri "produk mana yang memakai susu dari supplier X" mustahil selama satu batch dapat ditulis dalam empat cara berbeda. Merapikannya adalah **prasyarat** modul traceability, bukan sekadar kerapian data.

**Keputusan (25 Agustus 2026) — ditetapkan sebagai BR-21:**

| Aspek | Ketetapan |
|---|---|
| Prefiks | **`HRC`**, bukan `HC` — mengikuti penulisan yang sudah dipakai lapangan |
| Posisi angka | **Setelah prefiks**: `HRC1`, `HRC2`, `FC1`, `FC2` |
| Bentuk kanonik | `<PREFIKS><nomor>` — huruf besar, tanpa spasi, tanpa nol di depan |
| Prefiks baku | `HRC` dan `FC` — inilah dua yang seharusnya dipakai |
| Prefiks tambahan | `INK`, `FULLFM`, `SR` tetap diakui sebagai entri master data, ditandai **bukan baku** |
| Huruf besar | Diterapkan **otomatis**, bukan diandalkan pada kedisiplinan operator |
| CMD 2 | `CMD2` |
| PINDAH SILO | `TF TO <silo>`, dihasilkan sistem |

Yang membuat keputusan ini berbeda dari sekadar aturan validasi: **daftar prefiks menjadi master data yang dikelola, bukan konstanta di dalam kode** (FR-26.5). Tabel `batch_prefix` menyimpan seluruh prefiks beserta penanda `is_standar`, sehingga:

- `HRC` dan `FC` tampil lebih dulu dan ditandai sebagai pilihan baku.
- `INK`, `FULLFM`, dan `SR` tetap dapat dipilih tanpa membuat data lama menjadi tidak valid.
- Bila kelak produksi ingin menghentikan salah satu, cukup dinonaktifkan lewat menu Admin — data historis tetap utuh, dan tidak perlu menyentuh kode.
- Bila muncul jenis batch baru, penambahannya adalah pekerjaan Admin, bukan pekerjaan pengembang.

**Implementasi input.** Field batch berubah dari satu isian bebas menjadi **dropdown prefiks + input nomor**. Bentuk yang salah menjadi mustahil, bukan sekadar tidak dianjurkan — sehingga tidak ada lagi jalan bagi `1hrc`, `HRC 1`, atau `01HRC` untuk masuk ke basis data. Nilai kanonik dirakit sistem dari kedua komponen tersebut.

Keterangan produk yang selama ini menumpang di field batch (`240ml`, `FullFm`, `B.13`) dipindahkan ke field terpisah.

**Normalisasi data historis saat migrasi:**

| Bentuk asal | Hasil |
|---|---|
| `1HRC` · `1hrc` · `01hrc` · `HRC1 ` | `HRC1` |
| `10 fullfm` · `10FULLFM` | `FULLFM10` |
| `11ink 240ml` | `INK11` + keterangan `240ml` |
| `B.13INK` · `B 13 INK` | `INK13` |
| `Cmd2` · `CMD2 ` | `CMD2` |
| `7437` | **tak terpetakan** → laporan pengecualian, ditinjau manual |

### C.6 Aturan Agregasi Export

Diturunkan dari perbandingan output terhadap struktur data aplikasi:

**Halaman 1 — satu baris per penerimaan.** Bila satu penerimaan punya beberapa prepast (terpecah ke lebih dari satu silo), baris tetap satu dan kolom prepast digabung:

**Aturan penggabungan (dikonfirmasi 25 Agustus 2026):** ketika satu penerimaan terpecah ke beberapa silo, **seluruh variabel prosesnya identik** — waktu mulai, waktu selesai, flowrate, dan kedua suhu bernilai sama pada setiap pecahan. Yang berbeda hanya silo tujuannya. Pemecahan mencerminkan satu operasi prepasteurisasi yang keluarannya dialirkan ke lebih dari satu silo, bukan beberapa operasi terpisah.

Karena itu tidak ada ambiguitas agregasi:

| Kolom | Aturan |
|---|---|
| I — Prepast Mulai | nilai dari pecahan mana pun — semuanya sama |
| J — Prepast Selesai | idem |
| K, L, M — flowrate & suhu | idem |
| N — Disimpan di Silo No | daftar silo urut waktu prepast, dipisah `/` → `SILO25B/1/3` |

Konsekuensi yang perlu ditegakkan sistem: **bila nilai-nilai tersebut ternyata berbeda antar pecahan, itu adalah anomali data**, bukan kasus yang perlu diagregasi. Export menuliskan nilai dari pecahan pertama dan mencatat peringatan di log. Setelah migrasi, konsistensi ini sebaiknya ditegakkan di titik input — satu form prepast dengan beberapa silo tujuan, bukan beberapa form terpisah yang kebetulan bernilai sama.

Untuk B-18 (`SILO25A/25A`, `SILO6/6/25A`), deduplikasi tetap diterapkan pada tampilan. Nilai kembar berarti ada dua record prepast menuju silo yang sama dari satu penerimaan — kondisi yang tidak seharusnya muncul bila pemecahan memang satu operasi. Kasus semacam ini dicatat di log migrasi untuk ditinjau.

**Halaman 2 — pivot per silo.** Monitoring diurutkan `time_check` menaik dan diberi nomor urut I…VII per silo. Transfer diurutkan `trf_time` menaik, mengisi slot 1–7 lalu meluap ke baris berikutnya dalam blok.

**Cakupan status (dikonfirmasi 25 Agustus 2026):**

```
MASUK    : Pending Approval · Approved
TIDAK    : Rejected · REVISED · VOIDED · Edit Requested
```

Record yang belum disetujui **tetap masuk** catatan mutu — form diterbitkan mengikuti realita operasional harian, tidak menunggu SPV. Yang dikecualikan adalah record yang dibatalkan atau digantikan.

> **Interaksi dengan WF-3.** Status `Edit Requested` termasuk yang dikecualikan. Pada alur sekarang, itu berarti record yang sudah `Approved` **menghilang dari form** begitu operator mengajukan permintaan edit — persis celah yang diuraikan di 15.4. Setelah WF-3 diterapkan, status itu tidak lagi ada pada tabel transaksi (permintaan berpindah ke `correction_request`), sehingga record tetap `Approved` dan tetap terbit di form selama permintaannya diproses. Masalah ini menyelesaikan dirinya sendiri, dan sekaligus menjadi argumen tambahan untuk memprioritaskan WF-3.

**Batas kapasitas yang harus ditangani:**

| Batas | Nilai | Bila terlampaui |
|---|---|---|
| Baris penerimaan per hari | 17 | Terbanyak teramati 14 (12 Agustus). Sistem harus menerbitkan halaman lanjutan, tidak boleh memotong diam-diam. |
| Interval monitoring per silo | 7 | Silo 25A sudah mencapai 7 pada 6 Agustus — batasnya sudah tersentuh. |
| Transfer per silo per hari | 21 | Terbanyak teramati 9. |
| Jumlah silo | 8 (tetap) | Form tidak punya ruang untuk silo baru. Menambah silo menuntut revisi dokumen QA. |

Ketiga batas pertama harus memicu halaman lanjutan berlabel `Halaman n dari m`, disertai `log()` peringatan. Pemotongan diam-diam pada catatan mutu tidak dapat diterima.

### C.7 Dampak terhadap FR-12 dan WF-10

**Bentuk output diputuskan.** Usulan WF-10 sebelumnya menawarkan "satu workbook, satu sheet per hari". Setelah melihat file aslinya, itu **keliru** — setiap file adalah satu dokumen mutu bernomor yang ditandatangani terpisah. Menggabungkan 30 hari menjadi satu workbook justru merusak sifatnya sebagai rekaman.

Yang diperbaiki adalah hal lain:

| Aspek | Sekarang | Target |
|---|---|---|
| Sheet per file | 6 (4 template kosong) | **2** (`Hal 1`, `Hal 2`) |
| Ukuran file | ±100 KB | ±20 KB |
| Range bulanan | 30 file lepas | 30 file dalam **satu ZIP** + satu indeks |
| Tanggal | tertukar / bertipe teks | nilai `date` ber-`number_format` |
| Penerbitan | manual dari layar Export | manual **+ otomatis harian** pukul 06:00 untuk hari sebelumnya |
| Metadata dokumen | tertanam di template | tabel `form_template` |

Tabel pendukung nomor & revisi dokumen:

```sql
CREATE TABLE form_template (
  id            BIGINT PRIMARY KEY AUTO_INCREMENT,
  kode_form     VARCHAR(40)  NOT NULL,        -- 'CMD1/FRM/PRD/01'
  revisi        VARCHAR(10)  NOT NULL,        -- '02'
  berlaku_mulai DATE         NOT NULL,        -- 2025-03-11
  berlaku_sampai DATE        NULL,            -- NULL = masih berlaku
  judul         VARCHAR(200) NOT NULL,
  keterangan    TEXT NULL,                    -- '*) Setting Temp. : 90oC, Min Temp. : 81oC'
  UNIQUE KEY uq_form (kode_form, revisi)
) ENGINE=InnoDB;
```

Export memilih baris yang berlaku pada **tanggal data**, bukan tanggal cetak — sehingga form untuk Februari 2025 tetap terbit dengan Revisi 00, bukan Revisi 02.

### C.8 Requirement Baru

| ID | Requirement | Prioritas |
|---|---|---|
| FR-12.5 | Output mereplikasi tata letak form `CMD1/FRM/PRD/01` Rev 02 secara persis: merge, lebar kolom, catatan kaki, blok tanda tangan | P0 |
| FR-12.6 | Nomor dokumen, revisi, dan tanggal berlaku berasal dari `form_template`, dipilih menurut tanggal data | P0 |
| FR-12.7 | Tanggal ditulis sebagai nilai `date` dengan `number_format` `dd/mm/yyyy` (memperbaiki B-16) | P0 |
| FR-12.8 | Workbook hanya berisi 2 sheet | P0 |
| FR-12.9 | Kolom "Disimpan di Silo No" digabung dengan deduplikasi, urut waktu prepast, **seluruh elemen memakai nama tampilan secara seragam** — tidak mencampur nama tampilan dengan kode (memperbaiki B-18) | P0 |
| FR-12.10 | Kolom "Jumlah Awal (lt)" diisi dari Stock Opname; "Saldo (lt)" dihitung berjalan dari situ (memperbaiki B-17) | **Tahap lanjutan** — lihat 12.6 |
| FR-12.11 | Kelebihan kapasitas menerbitkan halaman lanjutan `Halaman n dari m`, tidak pernah memotong diam-diam | P0 |
| FR-12.12 | Range bulanan menghasilkan satu ZIP berisi file per hari + lembar indeks | P1 |
| FR-12.13 | Penerbitan otomatis harian pukul 06:00 untuk data hari sebelumnya | P1 |
| FR-12.14 | Blok tanda tangan dipertahankan sebagai area kosong untuk tanda tangan basah; e-signature ditinjau terpisah bersama QA | P2 |
| FR-12.15 | Pengembalian dan pindah silo ditulis sebagai **baris catatan di kaki blok transfer** Halaman 2, bukan kolom tabel (D-16) | P0 |
| FR-5.10 | Validasi `temp_after_heater ≥ 81 °C` sesuai catatan kaki OPRP; di bawah ambang memberi peringatan dan menuntut alasan | P1 |

---

## Lampiran D — Spesifikasi Visual Dashboard

Melengkapi FR-27. Bagian ini menetapkan bentuk, warna, dan aturan tiap panel sehingga hasilnya konsisten tanpa bergantung pada selera pelaksana.

### D.1 Urutan Perancangan

Bentuk lebih dulu, warna terakhir. Urutan ini disengaja — grafik yang buruk hampir selalu lahir dari memilih warna lebih dulu.

1. Tentukan **pekerjaan data**: besaran, identitas, polaritas, satu angka utama, atau perubahan lintas waktu
2. Pekerjaan itu menentukan **bentuk** — dan kadang jawabannya bukan grafik
3. Warna ditugaskan menurut perannya: kategorikal · sekuensial · divergen · status
4. **Palet divalidasi dengan alat, bukan dikira-kira**
5. Tambahkan lapisan interaksi
6. Periksa aksesibilitas
7. Render dan lihat hasilnya

### D.2 Palet

Palet berikut sudah **lolos validasi** pada mode terang maupun gelap: rentang kecerahan, ambang chroma, keterpisahan buta warna antar pasangan bersebelahan, ambang penglihatan normal, dan kontras terhadap permukaan.

**Kategorikal** — dipakai berurutan, tidak pernah diputar:

| Slot | Warna | Terang | Gelap | Dipakai untuk |
|---|---|---|---|---|
| 1 | biru | `#2a78d6` | `#3987e5` | Penerimaan / masuk |
| 2 | jingga | `#eb6834` | `#d95926` | Transfer / keluar |
| 3 | toska | `#1baf7a` | `#199e70` | Prepast |
| 4 | kuning | `#eda100` | `#c98500` | Pindah silo |

```
Terang  : CVD ΔE terburuk 9,1 (≥8) · penglihatan normal 22,9 (≥15) → LOLOS
Gelap   : CVD ΔE terburuk 8,4 (≥8) · penglihatan normal 19,8 (≥15) → LOLOS
```

Untuk bentuk yang membandingkan **semua pasangan sekaligus** (scatter, small multiples), berlaku batas **tiga seri** — slot 1–3 lolos uji semua-pasangan di kedua mode. Seri keempat menempatkan kuning bersebelahan dengan jingga dan gagal pada uji tersebut. Lebih dari tiga: lipat menjadi "Lainnya" atau pecah menjadi small multiples.

Pada mode terang, toska dan kuning berada di bawah kontras 3:1 terhadap permukaan. **Aturan keringanan berlaku**: kedua seri itu wajib membawa label langsung yang terlihat, atau tampilan tabel tersedia. Ini bukan syarat yang boleh diabaikan.

**Sekuensial** (besaran — heatmap jam kedatangan): biru satu hue, `#cde2fb` → `#0d366b`.

**Divergen** (selisih terhadap target — neraca masuk/keluar): biru ↔ merah dengan titik tengah abu netral (`#f0efec` terang, `#383835` gelap). Tidak pernah pelangi, tidak pernah hue di titik tengah.

**Status** — tidak pernah dipakai sebagai warna seri, selalu disertai ikon + label:

| Peran | Warna | Dipakai untuk |
|---|---|---|
| baik | `#0ca30c` | Dalam rentang aman |
| waspada | `#fab219` | Mendekati ambang |
| serius | `#ec835a` | Melewati ambang |
| kritis | `#d03b3b` | Pelanggaran OPRP, pH di luar rentang |

**Warna korporat `#393A69` dan `#69797E` tetap dipakai untuk kop, header, dan navigasi — bukan untuk seri data.** Warna merek dipilih untuk identitas, bukan untuk keterpisahan; memakainya sebagai warna seri akan menggagalkan uji buta warna.

### D.3 Ketentuan Tiap Panel

| Panel | Bentuk | Peran warna | Catatan |
|---|---|---|---|
| Total penerimaan | Angka utama + sparkline | — | ≥48px; delta memakai warna status |
| Pemakaian · Saldo · TS | Stat tile + delta | — | Bukan grafik batang satu batang |
| Utilisasi kapasitas | Meter | Sekuensial | Zona ambang pada rel yang sama |
| Neraca harian | Garis 2 seri | Kategorikal 1–2 | **Satu sumbu** — keduanya liter |
| Pola jam kedatangan | Heatmap jam × hari | Sekuensial biru | Sel ≥16px; tooltip menampilkan nilai |
| Aktivitas per silo | Batang bertumpuk horizontal | Kategorikal 3–4 | Horizontal karena nama silo panjang; jarak 2px antar segmen |
| Suhu simpan | Garis + pita rentang aman | 1 hue + abu | Pita adalah latar, bukan seri |
| pH per silo | Garis, **terpisah dari suhu** | 1 hue + abu | Skala berbeda — menggabungkannya berarti dua sumbu |
| Temp After Heater | Garis + garis ambang 81 °C | 1 hue; titik di bawah ambang berwarna kritis | **Panel terpenting** — titik kendali keamanan pangan |
| Temp Output | Garis, **grafik tersendiri** | 1 hue | ±7 °C berbanding ±87 °C — tidak mungkin satu sumbu |
| TS per supplier | Batang terurut + penanda rata-rata | Penekanan: 1 hue + abu | Yang di bawah rata-rata diberi penekanan |
| Volume per supplier | Batang terurut | Sekuensial | 8 teratas + "Lainnya" — 23 supplier terlalu banyak untuk warna |
| Standing time | Batang horizontal + zona ambang | Status | Terurut menurun; yang terlama di atas |
| Tujuan transfer | Batang bertumpuk | Kategorikal 1–2–4 | CMD1 · CMD2 · Pindah Silo |
| Waktu tunggu approval | Batang per modul | Sekuensial | Usia rata-rata antrean |

### D.4 Aturan yang Tidak Dapat Ditawar

- **Tidak pernah dua sumbu-Y.** Ini kesalahan grafik yang paling sering terjadi. Dua besaran berbeda skala menjadi dua grafik, small multiples, atau diindeks ke basis yang sama.
- **Warna mengikuti entitas, bukan peringkat.** Menyaring silo tidak boleh mengecat ulang silo yang tersisa.
- **Sekuensial = satu hue terang→gelap. Divergen = dua hue + abu netral di tengah.**
- **Warna status tidak pernah menjadi warna seri**, dan tidak pernah berdiri sendiri tanpa ikon + label.
- **Teks memakai warna teks, bukan warna seri.** Nilai, label, dan legenda tetap memakai tinta primer/sekunder; identitas dibawa oleh penanda berwarna di sebelahnya.
- **Legenda selalu ada untuk ≥2 seri**; ≤4 seri juga diberi label langsung. Satu seri tidak perlu legenda — judulnya sudah menamainya.
- Marka tipis, garis 2px, penanda ≥8px, jarak permukaan 2px antar isian bersebelahan, garis bantu dan sumbu bersifat surut.
- **Label langsung bersifat selektif** — tidak pernah angka di setiap titik.

### D.5 Interaksi

| Bentuk | Perilaku |
|---|---|
| Garis / area | Crosshair + tooltip seluruh seri pada posisi X |
| Batang / titik / sel | Tooltip per marka |
| Semua | Sasaran sentuh lebih besar dari marka; filter dalam satu baris di atas grafik |
| Semua | Tampilan tabel dapat dibuka dari grafik |

### D.6 Mode Gelap

Nilai mode gelap **dipilih tersendiri** dari ramp yang sama dan divalidasi terhadap permukaan gelap — bukan hasil pembalikan otomatis. Permukaan: `#fcfcfb` terang, `#1a1a19` gelap. Seluruh token warna didefinisikan pada lingkup akar, lalu ditimpa pada blok mode gelap.

### D.7 Kinerja

| ID | Ketentuan |
|---|---|
| D-7.1 | Agregasi dieksekusi di MySQL. Klien menerima data yang sudah teragregasi, tidak pernah baris mentah. |
| D-7.2 | Panel dimuat mandiri — panel lambat tidak menahan panel lain |
| D-7.3 | Agregasi harian yang sering dipakai disimpan dalam tabel ringkasan, disegarkan berkala |
| D-7.4 | Dashboard tampil di bawah 2 detik pada rentang 30 hari (NFR-1) |

---

## Lampiran E — Rincian Tugas Eksekusi

Menerjemahkan roadmap 18 minggu (Bagian 12) menjadi tugas yang dapat dikerjakan. Setiap tugas punya **definisi selesai** yang dapat diverifikasi — bukan "sudah dikerjakan", melainkan "terbukti bekerja".

Notasi ketergantungan: `← X` berarti tugas ini menunggu X selesai.

### E.1 Fase 0 — Fondasi (2 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F0-1 | Repositori, struktur direktori (7.2), linter, formatter | `npm run lint` bersih pada repo kosong |
| F0-2 | Docker Compose: Nginx + Node + MySQL (NFR-15) | `docker compose up` menyalakan ketiganya di mesin bersih |
| F0-3 | Migrasi skema MySQL — seluruh tabel Bagian 8.2 | Migrasi jalan dari basis data kosong tanpa error |
| F0-4 | `v_silo_volume` + `v_silo_monitoring_status` (8.3) | Query VIEW mengembalikan hasil benar atas data seed |
| F0-5 | Seed master data: silo, supplier, tank, prefiks batch, template form | Seluruh master terisi sesuai data produksi |
| F0-6 | Generator ID bersekuens harian (M-4) ← F0-3 | 1.000 ID paralel tanpa tabrakan |
| F0-7 | Auth: hash argon2id, JWT, refresh token (FR-1) | Login berhasil; token kedaluwarsa ditolak |
| F0-8 | Middleware RBAC sesuai matriks 2.10.1 (BR-22) ← F0-7 | T-16 lulus — endpoint menolak peran yang tidak berwenang |
| F0-9 | `audit_log` + hak akses append-only (A-1..A-8) ← F0-3 | `UPDATE`/`DELETE` oleh user aplikasi ditolak database |
| F0-10 | Kerangka penanganan error `{ code, message, details }` | Pelanggaran business rule mengembalikan kode BR-xx |
| F0-11 | Shell React: routing, layout, tema terang/gelap, komponen dasar | Shell tampil, navigasi berfungsi, tema berganti |
| F0-12 | CI: lint + uji + build pada setiap perubahan (T-35) | Pipeline hijau |
| F0-13 | NTP & pemantauan deviasi waktu (NFR-14) | Deviasi > 5 detik memicu peringatan |

> **F0-9 sebelum tugas transaksional mana pun.** Audit log yang ditambahkan belakangan selalu berlubang — operasi yang sudah ditulis lebih dulu tidak akan mencatat dirinya.

### E.2 Fase 1 — Alur Inti (4 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F1-1 | **`allocateFifo()` sebagai fungsi murni** (BR-04, BR-05) | T-5.1..T-5.8 lulus |
| F1-2 | Berkas uji emas dari 20 file export (T-1) | Berkas tersimpan di repo, terbaca uji |
| F1-3 | Uji alokasi terhadap data nyata (T-5.9) ← F1-1, F1-2 | Cocok dengan `supplier_fifo` historis |
| F1-4 | Layanan Receiving + koreksi (FR-4) | Kekekalan volume terjaga; audit tercatat |
| F1-5 | **Layanan Prepast multi-silo** (FR-29) ← F1-4 | N record dalam satu transaksi; T-19 lulus |
| F1-6 | Standing time: set · reset · warisan (BR-09) ← F1-5 | T-8 lulus keempat kasusnya |
| F1-7 | **Layanan Transfer** — transaksional, `FOR UPDATE` (M-5) ← F1-1, F1-5 | T-12, T-13 lulus |
| F1-8 | PINDAH SILO: prepast anak + warisan anchor (BR-10, BR-14) ← F1-7 | Kekekalan volume terjaga lintas silo |
| F1-9 | **Layanan Monitoring ronde multi-silo** (FR-30.1) | Satu transaksi untuk N silo |
| F1-10 | Pemindai QR + pemilihan manual (FR-3) | Berfungsi di tablet sungguhan |
| F1-11 | Form Receiving & Prepast — input waktu tunggal (WF-1) ← F1-4, F1-5 | Tidak ada lagi validasi "2 digit" |
| F1-12 | Form Transfer + pratinjau FIFO langsung (FR-6.3) ← F1-7 | Alokasi terhitung saat volume diketik |
| F1-13 | Form Monitoring ronde ← F1-9 | 8 silo dalam satu kali kirim |
| F1-14 | Dashboard beranda: kartu silo, standing time, status cek (FR-2) ← F0-4 | Angka cocok dengan Power Apps |
| F1-15 | Normalisasi batch + dropdown prefiks (BR-21, FR-30.3) | T-11 lulus; bentuk salah mustahil |

> **F1-1 mendahului segalanya di fase ini.** Ia fungsi murni tanpa I/O, jadi dapat ditulis dan diuji tuntas sebelum satu baris pun kode basis data disentuh. Bila ia benar, sisa modul Transfer hanyalah pengaturan transaksi.

### E.3 Fase 2 — Tata Kelola (3 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F2-1 | Layanan approval satuan (FR-9.2, FR-9.3) | Audit tercatat lengkap |
| F2-2 | **Guard dependensi** untuk edit, void, reject (BR-15) | T-15 lulus ketiga jalurnya |
| F2-3 | Approve massal transaksional, SPV saja (FR-16.2) ← F2-1 | Satu gagal → seluruh batch batal |
| F2-4 | Antrean approval terpadu + pengelompokan rantai (FR-16.1, 16.3) ← F2-3 | Rantai hulu-hilir tampil sebagai satu grup |
| F2-5 | **Reversal Prepast & Transfer** (BR-12, BR-13) ← F1-7 | T-6 lulus; kekekalan volume terjaga |
| F2-6 | **Cascade void** daun-ke-akar (BR-14, FR-17.2) ← F2-5 | T-7, T-29 lulus |
| F2-7 | Pohon dependensi + aksi void inline (FR-17.1) ← F2-6 | Tidak ada lagi dialog buntu |
| F2-8 | Koreksi in-place untuk record pra-approval (FR-14.1) ← F0-9 | Nilai sebelum/sesudah tercatat |
| F2-9 | `correction_request` + alur 2 langkah (FR-15) ← F2-8 | Record asli tetap `Approved` selama diproses |
| F2-10 | Draft: deteksi otomatis, badge, blokir approval (BR-23) | T-17 lulus |
| F2-11 | Data List berpaginasi + filter + pencarian (FR-10) | Tidak ada lagi muat seluruh tabel |
| F2-12 | Detail Silo + filter yang benar (memperbaiki B-7) | Filter tanggal benar-benar per tanggal |
| F2-13 | **Uji regresi BR-01..BR-23** (T-33) | Setiap aturan punya uji yang menyebut nomornya |

### E.4 Fase 3 — Pelengkap (2 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F3-1 | Stock Opname — upsert benar (memperbaiki B-2, B-3) | Unik per (periode, silo); validasi memblokir |
| F3-2 | **Definisi tata letak form sebagai struktur data** (FR-28.7) | Satu definisi, belum ada penyaji |
| F3-3 | Penyaji Excel via exceljs ← F3-2 | Hasil identik dengan form asli |
| F3-4 | Tanggal sebagai nilai date (memperbaiki B-16) ← F3-3 | Tanggal 1–12 tidak lagi tertukar |
| F3-5 | Agregasi Halaman 1 + dedupe silo (FR-12.9) ← F3-3 | Tidak ada lagi `SILO25A/25A` |
| F3-6 | Pivot Halaman 2 + luapan baris (FR-12.11) ← F3-3 | 21 transfer per silo tertangani |
| F3-7 | Template form dari `form_template` (FR-12.6) ← F3-3 | Revisi dipilih menurut tanggal data |
| F3-8 | Export ZIP bulanan + indeks (FR-12.12) ← F3-3 | 2 sheet per file, ±20 KB |

### E.5 Fase 3b — Master Data (2 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F3b-1 | Kerangka CRUD seragam + riwayat perubahan | Satu pola dipakai ulang seluruh halaman |
| F3b-2 | Manajemen User + reset PIN (FR-26.1.1) ← F3b-1 | PIN sementara wajib diganti saat login |
| F3b-3 | Manajemen Supplier (FR-26.1.2) ← F3b-1 | Nonaktif menyembunyikan dari input |
| F3b-4 | Manajemen Silo + ambang monitoring (FR-26.2.4) ← F3b-1 | **Mencabut akar B-19** |
| F3b-5 | Manajemen Tank (FR-26.1.4) ← F3b-1 | Menggantikan hardcode `colTankMaster` |
| F3b-6 | Manajemen Prefiks Batch (FR-26.1.5) ← F3b-1 | Prefiks baku tampil lebih dulu |
| F3b-7 | Manajemen Template Form (FR-26.1.6) ← F3-7 | Revisi baru tanpa sentuh kode |
| F3b-8 | Ringkasan Master Data (FR-26.1.7) ← F3b-2..7 | Jumlah entri & perubahan terakhir |

### E.6 Fase 3c — Dashboard & Pratinjau (3 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F3c-1 | Query agregasi + tabel ringkasan (D-7.1, D-7.3) | Seluruh agregasi di MySQL |
| F3c-2 | Token warna + validasi palet (FR-27.5.6) | Validator lulus terang & gelap |
| F3c-3 | Komponen grafik dasar: garis, batang, heatmap, meter, stat tile ← F3c-2 | Sesuai ketentuan marka D.4 |
| F3c-4 | Baris ringkasan (FR-27.2) ← F3c-1, F3c-3 | Angka cocok dengan Data List |
| F3c-5 | **Panel Perhatian** (FR-27.3) ← F3c-1 | Enam jenis peringatan, dapat diklik |
| F3c-6 | Grafik tren & mutu (FR-27.4) ← F3c-3 | Tidak ada dua sumbu-Y |
| F3c-7 | Tampilan tabel + ekspor per panel (FR-27.1.4, 1.6) ← F3c-6 | Setiap grafik punya tabelnya |
| F3c-8 | **Penyaji HTML** dari definisi yang sama (FR-28.1, 28.7) ← F3-2 | Pratinjau identik dengan Excel |
| F3c-9 | Panel validasi pra-export (FR-28.3..28.5) ← F3c-8 | Pemblokir vs peringatan dibedakan |
| F3c-10 | Navigasi halaman & tanggal pada pratinjau (FR-28.6) ← F3c-8 | Hal 1/2 dan antar tanggal |

### E.7 Fase 4 — Migrasi & Go-live (2 minggu)

| ID | Tugas | Definisi selesai |
|---|---|---|
| F4-1 | Ekstraksi 9 SharePoint List ke staging | Jumlah baris cocok |
| F4-2 | Parsing datetime string + laporan pengecualian ← F4-1 | Format tak terbaca masuk laporan |
| F4-3 | Resolusi relasi string → foreign key ← F4-2 | V-3 lulus |
| F4-4 | **Parsing `supplier_fifo` → `transfer_allocation`** ← F4-3 | V-4 lulus |
| F4-5 | Identifikasi anak PINDAH SILO ← F4-4 | Ambigu masuk tinjauan manual |
| F4-6 | Normalisasi batch historis (BR-21) ← F4-3 | Tak terpetakan masuk laporan |
| F4-7 | Verifikasi V-1..V-6 otomatis (T-20) ← F4-4 | Seluruhnya lulus |
| F4-8 | **Uji replay 20 file** (T-2, T-3) ← F4-7 | Setiap selisih terklasifikasi |
| F4-9 | Dry run 3× pada salinan produksi (T-21) ← F4-8 | Tiga kali berturut lulus |
| F4-10 | Penyiapan server on-prem: OS, Docker, TLS, UPS, NTP (Bagian 17) | Health check hijau |
| F4-11 | Backup otomatis + **uji restore** (NFR-17, NFR-18) ← F4-10 | Restore terbukti berhasil |
| F4-12 | Verifikasi jangkauan WiFi lantai produksi (17.5.2) | Terverifikasi di area penerimaan & silo |
| F4-13 | UAT seluruh peran (T-24..T-32) ← F4-9, F4-10 | Seluruh skenario disetujui pengguna |
| F4-14 | Distribusi PIN baru + pelatihan | Seluruh operator dapat login |
| F4-15 | Cutover (11.4) ← F4-13, F4-14 | Produksi berjalan |

**Catatan implementasi (F4-1 s/d F4-8, selesai 26 Ags 2026).** Pipeline migrasi
ada di `server/src/migrasi/`, dijalankan lewat `npm run migrasi -- --sumber <folder>`.
Panduan lengkap penyiapan berkas sumber di [`docs/MIGRASI.md`](MIGRASI.md).

| Berkas | Peran |
|---|---|
| `sumberKolom.js` | Peta kolom SharePoint ke MySQL, dibaca dari pemanggilan `Patch()` di YAML Power Apps |
| `parseNilai.js` | Parsing waktu, angka, dan JSON dengan penolakan yang eksplisit |
| `bacaSumber.js` | Pembaca `.xlsx` dan `.csv`, mengenali kolom dari baris kepala |
| `muat.js` | Pipeline pemuatan berurutan, idempoten, dengan laporan pengecualian |
| `verifikasi.js` | V-1 s/d V-6 sebagai fungsi, dijalankan otomatis tiap kali migrasi jalan (T-20) |
| `jalankan.js` | CLI, menulis laporan pengecualian CSV dan laporan verifikasi JSON |

**Dua sifat yang membentuk seluruh pipeline.**

*Idempoten (T-23).* Baris dikenali dari `Title` SharePoint dan ditulis dengan
`ON DUPLICATE KEY UPDATE`; alokasi FIFO dibersihkan per transfer sebelum ditulis
ulang. Diuji dengan menjalankan pemuatan dua kali dan menuntut jumlah baris yang
sama persis. Ini bukan kemewahan: T-21 menuntut dry run diulang tiga kali, dan
migrasi yang hanya boleh dijalankan sekali tidak dapat memenuhinya.

*Tidak menebak.* Nilai yang tidak terbaca menolak barisnya dan masuk laporan.
Tidak ada nilai bawaan yang menggantikan data hilang. Yang dimigrasikan adalah
catatan mutu: menebak satu jam penerimaan berarti menerbitkan form GMP dengan jam
yang tidak pernah terjadi, dan setelah Power Apps dipensiunkan tidak ada lagi
pembandingnya.

**Satu baris buruk tidak menjatuhkan seluruh muatan.** Tiap baris memakai
SAVEPOINT sendiri, sehingga baris yang melanggar kekangan digulung balik
sendirian dan laporannya tetap lengkap dalam satu kali jalan. Ini ditemukan saat
pengujian: sebelum diperbaiki, satu prepast tanpa supplier menggagalkan seluruh
transaksi dan laporannya berhenti di baris itu.

**Tiga temuan lain dari pengujian.**

1. `normalisasiBatch()` mengembalikan properti `batch`, bukan `kanonik`. Kode
   migrasi memakai nama yang salah, sehingga SETIAP batch jatuh ke cabang "tidak
   terpetakan" dan tidak ada satu pun yang dinormalkan. Lolos tanpa galat, dan
   hanya terlihat karena ada uji yang memeriksa hasil normalisasinya.
2. Nilai ENUM dari sumber divalidasi di lapis migrasi, bukan diserahkan ke MySQL.
   MySQL dalam mode longgar menerima nilai asing sebagai string kosong tanpa
   berkata apa-apa, dan status kosong pada catatan mutu tidak dapat dibedakan
   dari status yang memang belum diisi. Ejaan lama yang sudah diketahui
   dipetakan (`PREPASTED` ke `COMPLETED`), sisanya masuk laporan.
3. V-5 ternyata sudah dicegah kekangan `ck_pst_remaining`, jadi keadaan yang
   dicarinya tidak dapat dibuat lewat jalur mana pun. V-5 tetap dipertahankan
   sebagai lapis kedua, dan ujinya diubah menjadi membuktikan kekangannya
   memang menolak.

**V-1 tanpa pembanding dilaporkan TIDAK DAPAT DIPERIKSA, bukan lulus.** Sistem
baru tidak punya cara mengetahui angka Power Apps. Volume acuan harus dicatat
dari layar sistem lama saat pembekuan input dan diberikan lewat `--acuan`;
setelah pembekuan lewat, angka itu tidak dapat diambil lagi.

**Belum dikerjakan.** F4-9 (dry run pada salinan produksi) menunggu export
sungguhan. F4-10 s/d F4-15 adalah pekerjaan infrastruktur, UAT, dan cutover yang
menuntut akses server dan kehadiran pengguna. Uji T-13 (dua transfer benar-benar
bersamaan) masih terbuka dari F2-13.

### E.8 Perbaikan Mendahului Migrasi

Dikerjakan **sekarang** di Power Apps, tidak menunggu 18 minggu. Tidak bergantung pada tugas mana pun di atas.

| ID | Perbaikan | Alasan |
|---|---|---|
| P-1 | **B-19** — ganti perbandingan `silo_name` menjadi `Title` di `Scr_Home` (dua tempat: `siloStats` dan `timerRefresh`) | Ambang 2 jam SILO 25A/25B tidak pernah aktif; 141 dari 171 penerimaan bermuara ke sana |
| P-2 | **B-5** — tampilkan ikon reject di tab Receiving, Prepast, Transfer | Jalur reject tersembunyi di tiga dari empat modul |
| P-3 | **B-4** — perbaiki hitungan Edit Request tab Prepast | Menampilkan angka dari koleksi Transfer |
| P-4 | **B-6** — perbaiki teks toast tombol "No" pada dialog Edit Request | Menampilkan "Edit Request Approved" saat menolak |

P-1 paling mendesak. P-2 membuka jalur yang belum pernah dipakai — perlu diumumkan ke SPV lebih dulu, bukan sekadar diaktifkan diam-diam.

### E.9 Jalur Kritis

Rangkaian tugas yang menentukan panjang proyek. Keterlambatan di sini menggeser seluruh jadwal:

```
F0-3 skema  →  F1-1 allocateFifo  →  F1-7 Transfer  →  F2-5 Reversal
     →  F2-6 Cascade void  →  F4-4 Parsing FIFO  →  F4-8 Uji replay  →  F4-15 Cutover
```

Seluruhnya berkisar pada satu hal: **kebenaran alokasi FIFO dan pemutarbalikannya.** Bila F1-1 selesai lebih awal dan terbukti benar terhadap data nyata (F1-3), sisa proyek menjadi jauh lebih dapat diperkirakan.

Yang **tidak** berada di jalur kritis dan dapat dikerjakan paralel: dashboard (Fase 3c), master data (Fase 3b), dan seluruh pekerjaan tampilan.
