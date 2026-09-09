-- ============================================================
-- 007_pengembalian.sql - Pengembalian FM ke silo (BR-25)
--
-- Susu yang sudah ditransfer keluar dapat dikembalikan ke silo, tetapi
-- komposisi suppliernya sudah tidak diketahui: di tank maupun jalur pipa,
-- susu dari beberapa supplier sudah tercampur dan tidak dapat dipisahkan lagi.
--
-- Ini MEMUTUS satu asumsi inti sistem: sampai sekarang setiap liter di silo
-- dapat ditelusuri ke supplier lewat rantai receiving -> prepast -> transfer.
-- Volume tanpa identitas supplier memutus rantai itu, dan pemutusan itu harus
-- TERLIHAT, bukan disamarkan.
--
-- Tiga hal yang sengaja TIDAK dilakukan:
--   1. Tidak membuat supplier semu "PENGEMBALIAN". Itu akan membuat volume
--      tak dikenal ikut terhitung dalam analisa per supplier seolah-olah ia
--      pemasok sungguhan.
--   2. Tidak memakai tabel terpisah. Mesin FIFO adalah bagian paling berisiko
--      di sistem ini dan sudah terbukti benar; membuatnya polimorfik demi
--      kerapian model bukan pertukaran yang sepadan.
--   3. Tidak menebak komposisi supplier secara proporsional. Menebak akan
--      menghasilkan angka yang tampak pasti padahal tidak.
-- ============================================================

ALTER TABLE prepast_record
  -- Pembeda jenis isi silo. PREPAST berasal dari buffer lewat prepasteurisasi;
  -- PENGEMBALIAN adalah susu yang kembali dari tank atau jalur produksi.
  ADD COLUMN jenis_batch ENUM('PREPAST','PENGEMBALIAN') NOT NULL DEFAULT 'PREPAST'
    COMMENT 'BR-25 - PENGEMBALIAN tidak melalui prepasteurisasi'
    AFTER kode,
  -- NULL berarti identitas supplier sungguh-sungguh tidak diketahui,
  -- bukan sekadar belum diisi.
  MODIFY COLUMN supplier_id BIGINT NULL
    COMMENT 'NULL hanya untuk PENGEMBALIAN dengan asal tak diketahui',
  ADD COLUMN alasan_kembali TEXT NULL
    COMMENT 'Wajib untuk PENGEMBALIAN - ditegakkan di lapis service',
  ADD COLUMN keterangan_asal VARCHAR(255) NULL
    COMMENT 'Dari mana susu kembali, mis. "MT 1 batch HRC5"';

-- Supplier pada alokasi transfer ikut boleh kosong: transfer yang mengambil
-- dari batch pengembalian mewarisi ketidaktahuan itu, dan itu harus menular
-- supaya tidak ada titik di mana asal-usul tampak lebih pasti daripada
-- kenyataannya.
ALTER TABLE transfer_allocation
  MODIFY COLUMN supplier_id BIGINT NULL;

-- Hanya PENGEMBALIAN yang boleh tanpa supplier. Batch prepast tanpa supplier
-- adalah data rusak, bukan keadaan yang sah.
ALTER TABLE prepast_record
  ADD CONSTRAINT ck_pst_supplier_wajib CHECK (
    jenis_batch = 'PENGEMBALIAN' OR supplier_id IS NOT NULL
  );

CREATE INDEX idx_pst_jenis ON prepast_record (jenis_batch, silo_tujuan_id);
