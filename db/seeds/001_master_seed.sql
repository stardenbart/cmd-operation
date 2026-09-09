-- ============================================================
-- 001_master_seed.sql — Seed master data
--
-- ⚠  SEBELUM GO-LIVE, PERIKSA YANG BERTANDA [VERIFIKASI]
--    Nilai tersebut belum dikonfirmasi terhadap Silo_Master /
--    Supplier_Master di SharePoint dan diisi placeholder.
-- ============================================================

-- ------------------------------------------------------------
-- SILO
-- Nama diambil dari data export nyata: TANPA SPASI (SILO25A),
-- bukan "SILO 25A". Perbedaan inilah akar B-19.
--
-- monitoring_interval_jam: 2 untuk 25A & 25B, 4 untuk sisanya (BR-10).
-- Di Power Apps ambang ini tidak pernah aktif karena dibandingkan
-- terhadap nama silo yang berspasi.
--
-- [VERIFIKASI] kapasitas_maks_ltr masih 0 — WAJIB diisi dari Silo_Master.
-- Sengaja 0, bukan angka karangan: 0 membuat persen_isi = 0 dan
-- terlihat jelas belum diisi, ketimbang menampilkan angka yang salah.
-- ------------------------------------------------------------
INSERT INTO silo (kode, silo_name, qr_code_value, kapasitas_maks_ltr, is_buffer, monitoring_interval_jam, urutan) VALUES
  ('000', 'BUFFER',   'SILO-000', 0, TRUE,  4, 0),
  ('1',   'SILO1',    'SILO-1',   0, FALSE, 4, 1),
  ('2',   'SILO2',    'SILO-2',   0, FALSE, 4, 2),
  ('3',   'SILO3',    'SILO-3',   0, FALSE, 4, 3),
  ('4',   'SILO4',    'SILO-4',   0, FALSE, 4, 4),
  ('5',   'SILO5',    'SILO-5',   0, FALSE, 4, 5),
  ('6',   'SILO6',    'SILO-6',   0, FALSE, 4, 6),
  ('25A', 'SILO25A',  'SILO-25A', 0, FALSE, 2, 7),
  ('25B', 'SILO25B',  'SILO-25B', 0, FALSE, 2, 8)
ON DUPLICATE KEY UPDATE silo_name = VALUES(silo_name);

-- ------------------------------------------------------------
-- TANK PRODUKSI
-- Menggantikan colTankMaster yang di-hardcode di App.OnStart.
-- cmd_destination = CMD2 hanya untuk tank CMD 2 (BR-18).
-- ------------------------------------------------------------
-- aturan_batch — lihat 011_aturan_batch_tank.sql. Aturannya data, bukan
-- perbandingan nama di dalam kode: nama tangki dapat diubah lewat Master Data.
INSERT INTO tank_master (tank_name, qr_value, tank_trf_value, cmd_destination, aturan_batch, urutan) VALUES
  ('MT 1',             'TANK-MT1',   'MT 1',      'CMD1', 'PILIH',       1),
  ('MT 2',             'TANK-MT2',   'MT 2',      'CMD1', 'PILIH',       2),
  ('MT 3',             'TANK-MT3',   'MT 3',      'CMD1', 'PILIH',       3),
  ('MT 4',             'TANK-MT4',   'MT 4',      'CMD1', 'PILIH',       4),
  ('MT 5',             'TANK-MT5',   'MT 5',      'CMD1', 'PILIH',       5),
  ('MT 10',            'TANK-MT10',  'MT 10',     'CMD1', 'PILIH',       6),
  ('MT 11',            'TANK-MT11',  'MT 11',     'CMD1', 'PILIH',       7),
  ('MT 12',            'TANK-MT12',  'MT 12',     'CMD1', 'PILIH',       8),
  ('CMD 2',            'TANK-CMD2',  'CMD 2',     'CMD2', 'TETAP_CMD2',  9),
  ('PENGOSONGAN SILO', 'TANK-000',   'TANK 000',  'CMD1', 'TANPA_BATCH', 10)
ON DUPLICATE KEY UPDATE
  tank_trf_value = VALUES(tank_trf_value),
  aturan_batch   = VALUES(aturan_batch);

-- ------------------------------------------------------------
-- SUPPLIER — 23 supplier dari data export Agustus 2026
-- [VERIFIKASI] kode masih diturunkan dari nama. Ganti dengan kode
-- sesungguhnya dari Supplier_Master saat migrasi (lihat 002_master_nyata.sql).
--
-- ON DUPLICATE KEY UPDATE mengenai baris lewat NAMA berkat kunci unik
-- uq_supplier_name (migrasi 015). Tanpa kunci itu, seed ulang setelah 002
-- mengganti kode akan menyisipkan kembaran bernama sama - itulah bug yang
-- 015 tutup. Jangan lepas kunci itu tanpa mengganti penjaganya di sini.
-- ------------------------------------------------------------
INSERT INTO supplier (kode, supplier_name) VALUES
  ('AKB',  'Aneka Karya Boyolali'),
  ('AJI',  'Asli Juara Indonesia'),
  ('BSSI', 'BSSI'),
  ('ERF',  'Erif Farm'),
  ('GMR',  'Gemah Ripah'),
  ('GMS',  'Getasan Mandiri Sejahtera'),
  ('GRT',  'Giri Tani'),
  ('GGL',  'Great Giant Livestock'),
  ('KPSC', 'KPS Cianjur Utara'),
  ('KPSP', 'KPSP Saluyu'),
  ('KUDB', 'KUD Mandiri Bayongbong'),
  ('KKN',  'Kokarnaba'),
  ('KRH',  'Kurnia Rahayu'),
  ('MMS',  'Mandiri Mitra Sejahtera'),
  ('PST',  'PESAT'),
  ('PTL',  'Pita Lestari'),
  ('RGSB', 'RGSB Berkah Jaya'),
  ('RSBT', 'RSB Tapos'),
  ('SSHT', 'SSHT'),
  ('STK',  'Setia Kawan'),
  ('SCA',  'Sumber Citarasa Alam'),
  ('SNB',  'Susu Nusantara Berjaya'),
  ('TWL',  'Tani Wilis')
ON DUPLICATE KEY UPDATE supplier_name = VALUES(supplier_name);

-- ------------------------------------------------------------
-- PREFIKS BATCH (BR-21)
-- HRC & FC adalah bentuk baku. INK, FULLFM, SR tetap diakui karena
-- muncul nyata di data (INK 52x), ditandai bukan baku.
-- ------------------------------------------------------------
INSERT INTO batch_prefix (kode, label, is_standar, urutan) VALUES
  ('HRC',    'HRC',              TRUE,  1),
  ('FC',     'FC',               TRUE,  2),
  ('INK',    'Inkubasi',         FALSE, 3),
  ('FULLFM', 'Full Fresh Milk',  FALSE, 4),
  ('SR',     'SR',               FALSE, 5)
ON DUPLICATE KEY UPDATE label = VALUES(label);

-- ------------------------------------------------------------
-- TEMPLATE FORM GMP
-- Dipilih menurut TANGGAL DATA, bukan tanggal cetak (FR-12.6) —
-- sehingga form untuk periode lama terbit dengan revisi yang benar.
-- ------------------------------------------------------------
INSERT INTO form_template (kode_form, revisi, berlaku_mulai, berlaku_sampai, judul, keterangan) VALUES
  ('CMD1/FRM/PRD/01', '00', '2023-06-10', '2025-03-10',
   'Penerimaan, Pre Pasteurisasi, Pemakaian dan Monitoring Susu Segar', NULL),
  ('CMD1/FRM/PRD/01', '02', '2025-03-11', NULL,
   'Penerimaan, Pre-Pasteurisasi, Pemakaian dan Monitoring Susu Segar',
   '*) Setting Temp. : 90oC, Min Temp. : 81oC')
ON DUPLICATE KEY UPDATE judul = VALUES(judul);

-- ------------------------------------------------------------
-- OPERATOR AWAL
-- [VERIFIKASI] Satu akun Admin untuk memulai. PIN dibangkitkan lewat
-- skrip seed Node (bukan di SQL, agar tidak pernah ada PIN plaintext
-- di berkas mana pun). Operator lain dimasukkan lewat migrasi data
-- atau lewat Manajemen User (FR-26.1.1).
-- Lihat: server/src/db/seed.js
-- ------------------------------------------------------------
