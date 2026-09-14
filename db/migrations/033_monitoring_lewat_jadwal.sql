-- ============================================================
-- 033_monitoring_lewat_jadwal.sql
-- Jejak celah jadwal monitoring (BR-10, FR-30.1).
--
-- v_silo_monitoring_status hanya membandingkan SEKARANG dengan cek
-- terakhir — begitu ada cek baru (biarpun telat), status langsung "OK"
-- lagi dan jejak bahwa satu (atau lebih) jadwal cek terlewat di antaranya
-- hilang sama sekali, tidak pernah tersimpan di mana pun. Ini menutup
-- celah itu: dicatat SEKALI, permanen, di baris cek yang menyusul.
--
-- jam_sejak_cek_sebelumnya  -> selisih jam dari cek SEBELUMNYA pada silo
--                              yang sama (NULL = ini cek pertama silo itu).
-- lewat_jadwal              -> TRUE bila selisih itu melebihi
--                              monitoring_interval_jam silo pada saat cek
--                              ini dibuat (snapshot, sama seperti
--                              val_aktual_snapshot_ltr).
-- ============================================================

ALTER TABLE monitoring
  ADD COLUMN jam_sejak_cek_sebelumnya DECIMAL(6,2) NULL
    COMMENT 'BR-10 — selisih jam dari cek sebelumnya pada silo yang sama; NULL bila cek pertama'
    AFTER val_aktual_snapshot_ltr,
  ADD COLUMN lewat_jadwal BOOLEAN NOT NULL DEFAULT FALSE
    COMMENT 'BR-10 — TRUE bila jam_sejak_cek_sebelumnya melebihi monitoring_interval_jam saat itu'
    AFTER jam_sejak_cek_sebelumnya,
  ADD INDEX idx_mtr_lewat_jadwal (lewat_jadwal);
