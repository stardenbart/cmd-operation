-- ============================================================
-- 002_master_nyata.sql — Master data SESUNGGUHNYA
--
-- Menggantikan nilai placeholder di 001_master_seed.sql:
--   • Kapasitas silo — dikonfirmasi 25 Agustus 2026, total 69.000 L
--   • Kode supplier  — dari reference/kode_supplier.xlsx (kode SAP)
-- ============================================================

-- ------------------------------------------------------------
-- KAPASITAS SILO (total 69.000 L)
--
-- SILO4 dan SILO5 TIDAK disebut dalam kapasitas yang dikonfirmasi, dan
-- tidak pernah muncul sebagai tujuan pada 171 baris data export Agustus.
-- Keduanya dinonaktifkan, bukan dihapus: penonaktifan menyembunyikannya
-- dari pilihan input tanpa memutus data historis apa pun (FR-26.2.1).
-- ------------------------------------------------------------
UPDATE silo SET kapasitas_maks_ltr = 25000, toleransi_ltr = 1000 WHERE kode = '25A';
UPDATE silo SET kapasitas_maks_ltr = 25000, toleransi_ltr = 1000 WHERE kode = '25B';
UPDATE silo SET kapasitas_maks_ltr =  5000, toleransi_ltr = 1000 WHERE kode = '1';
UPDATE silo SET kapasitas_maks_ltr =  5000, toleransi_ltr = 1000 WHERE kode = '2';
UPDATE silo SET kapasitas_maks_ltr =  6000, toleransi_ltr = 1000 WHERE kode = '3';
UPDATE silo SET kapasitas_maks_ltr =  3000, toleransi_ltr = 1000 WHERE kode = '6';

UPDATE silo SET is_active = FALSE, is_available = FALSE WHERE kode IN ('4', '5');

-- Buffer bukan bagian dari 69.000 L — ia penampung sementara, bukan
-- kapasitas simpan. Angkanya masih [VERIFIKASI].
UPDATE silo SET kapasitas_maks_ltr = 50000, toleransi_ltr = 1000 WHERE kode = '000';

-- ------------------------------------------------------------
-- SUPPLIER — kode SAP dari reference/kode_supplier.xlsx
--
-- Kode placeholder yang diturunkan dari nama (SSHT, KUDB, ...) diganti
-- kode sesungguhnya. Pencocokan lewat supplier_name karena itulah satu-
-- satunya kunci yang sama antara data export dan berkas kode.
-- ------------------------------------------------------------
UPDATE supplier SET kode = '1100000389' WHERE supplier_name = 'Kurnia Rahayu';
UPDATE supplier SET kode = '1100000342' WHERE supplier_name = 'Erif Farm';
UPDATE supplier SET kode = '1100000372' WHERE supplier_name = 'Giri Tani';
UPDATE supplier SET kode = '1100000478' WHERE supplier_name = 'RSB Tapos';
UPDATE supplier SET kode = '1100000552' WHERE supplier_name = 'KPS Cianjur Utara';
UPDATE supplier SET kode = '1100000555' WHERE supplier_name = 'Pita Lestari';
UPDATE supplier SET kode = '1100000556' WHERE supplier_name = 'Mandiri Mitra Sejahtera';
UPDATE supplier SET kode = '1100000557' WHERE supplier_name = 'RGSB Berkah Jaya';
UPDATE supplier SET kode = '1100000558' WHERE supplier_name = 'KPSP Saluyu';
UPDATE supplier SET kode = '1100000560' WHERE supplier_name = 'KUD Mandiri Bayongbong';
UPDATE supplier SET kode = '1100000565' WHERE supplier_name = 'PESAT';
UPDATE supplier SET kode = '1100000568' WHERE supplier_name = 'Great Giant Livestock';
UPDATE supplier SET kode = '1100000592' WHERE supplier_name = 'Setia Kawan';
UPDATE supplier SET kode = '1100001970' WHERE supplier_name = 'SSHT';
UPDATE supplier SET kode = '1100001993' WHERE supplier_name = 'Asli Juara Indonesia';
UPDATE supplier SET kode = '1200000019' WHERE supplier_name = 'Sumber Citarasa Alam';
UPDATE supplier SET kode = '2100000119' WHERE supplier_name = 'Gemah Ripah';
UPDATE supplier SET kode = '2100001516' WHERE supplier_name = 'Tani Wilis';
UPDATE supplier SET kode = '2100002263' WHERE supplier_name = 'BSSI';
UPDATE supplier SET kode = '2100002273' WHERE supplier_name = 'Susu Nusantara Berjaya';
UPDATE supplier SET kode = '2100002591' WHERE supplier_name = 'Aneka Karya Boyolali';
UPDATE supplier SET kode = '2100002592' WHERE supplier_name = 'Kokarnaba';
UPDATE supplier SET kode = '2100002593' WHERE supplier_name = 'Getasan Mandiri Sejahtera';

-- Supplier yang terdaftar di berkas kode tetapi belum muncul di data
-- transaksi Agustus. Ditambahkan agar master lengkap; bila kelak ada
-- penerimaan darinya, tidak perlu penambahan mendadak.
INSERT INTO supplier (kode, supplier_name) VALUES
  ('1100000340', 'KPS Bogor'),
  ('1100000553', 'KSU Nusantara'),
  ('1100000554', 'Fajar Taurus'),
  ('1100000561', 'Pramono'),
  ('1100001973', 'Kerjen Rukun Santoso'),
  ('1100012608', 'KSU Tandangsari'),
  ('2100001391', 'Tani Makmur'),
  ('2100001490', 'Bangun Lestari'),
  ('2100001501', 'Sapi Jaya')
ON DUPLICATE KEY UPDATE supplier_name = VALUES(supplier_name);
