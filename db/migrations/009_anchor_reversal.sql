-- ============================================================
-- 009_anchor_reversal.sql - Menyimpan anchor untuk pemulihan void
--
-- Transfer dapat MERESET anchor silo asal (transfer penuh) dan MENGISI anchor
-- silo tujuan (pindah silo). Tanpa menyimpan keadaan sebelumnya, void tidak
-- dapat memulihkannya.
--
-- Menghitung ulang anchor dari batch tertua yang tersisa terdengar lebih
-- sederhana, tetapi salah untuk pindah silo: di sana anchor DIWARISI dari
-- silo asal dan lebih tua daripada prepast_finish anak yang lahir dari
-- transfer itu. Menghitung ulang akan memuda-kan susu yang sesungguhnya
-- sudah lama berdiri, dan standing time adalah indikator mutu.
-- ============================================================

ALTER TABLE transfer
  ADD COLUMN anchor_asal_sebelum DATETIME NULL
    COMMENT 'Anchor silo asal sebelum transfer ini mereset-nya; NULL bila tidak mereset'
    AFTER standing_time_menit,
  ADD COLUMN anchor_tujuan_diset BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'TRUE bila transfer ini yang mengisi anchor silo tujuan (pindah silo)'
    AFTER anchor_asal_sebelum;
