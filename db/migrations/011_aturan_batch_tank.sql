-- ============================================================
-- 011  Aturan batch mengikuti tangkinya
-- ============================================================
--
-- Tiga tangki berperilaku berbeda soal batch, dan sampai sekarang bedanya
-- hanya ada di kepala operator:
--
--   CMD 2             batchnya SELALU "CMD2". Tidak ada nomor, tidak ada
--                     pilihan. Sebelumnya operator harus memilih prefiks
--                     "CMD2" yang bahkan tidak ada di tabel batch_prefix,
--                     sehingga pilihan itu tidak pernah dapat dibuat.
--   MT 1 .. MT 12     operator memilih prefiks lalu mengetik nomornya.
--   PENGOSONGAN SILO  bukan produksi. Susunya dibuang atau dikembalikan,
--                     jadi tidak ada batch produksi yang dapat disebut.
--                     Memaksa operator mengisi batch di sini menghasilkan
--                     nomor batch karangan pada catatan mutu.
--
-- Aturannya dijadikan DATA, bukan perbandingan nama di dalam kode. Nama
-- tangki dapat berubah lewat Master Data, dan kode yang membandingkan
-- "PENGOSONGAN SILO" akan diam-diam berhenti bekerja saat itu terjadi -
-- tanpa galat, hanya dengan meminta batch yang seharusnya tidak diminta.
-- ============================================================

ALTER TABLE tank_master
  ADD COLUMN aturan_batch ENUM('PILIH', 'TETAP_CMD2', 'TANPA_BATCH')
    NOT NULL DEFAULT 'PILIH'
    COMMENT 'BR-21: PILIH = prefiks + nomor, TETAP_CMD2 = selalu CMD2, TANPA_BATCH = tidak berbatch'
    AFTER cmd_destination;

-- Tangki tujuan CMD 2 dikenali dari cmd_destination, bukan dari namanya.
UPDATE tank_master SET aturan_batch = 'TETAP_CMD2' WHERE cmd_destination = 'CMD2';

-- PENGOSONGAN SILO hanya dapat dikenali dari namanya SEKARANG, sebab belum
-- ada penciri lain. Sesudah ini, penandanya kolom di atas.
UPDATE tank_master SET aturan_batch = 'TANPA_BATCH' WHERE tank_name = 'PENGOSONGAN SILO';
