-- ============================================================
-- 029_pengaturan_aplikasi.sql
--
-- Bagian 1 — rollback migrasi 028 (salah paham kebutuhan: yang dimaksud
-- bukan menyembunyikan SILO tertentu dari dropdown, melainkan menyembunyikan
-- TEKS "sisa X L"-nya untuk SEMUA silo sekaligus, sebagai preferensi
-- tampilan global — bukan atribut per silo).
--
-- Bagian 2 — infrastruktur pengaturan aplikasi PERTAMA yang bersifat global
-- (berlaku sama untuk semua orang), bukan per-baris master data. Satu tabel
-- baris tunggal (id selalu 1) supaya pengaturan berikutnya tinggal menambah
-- kolom di sini, bukan membuat tabel baru lagi tiap kali.
-- ============================================================

ALTER TABLE silo
  DROP COLUMN sembunyikan_jika_penuh;

CREATE OR REPLACE VIEW v_silo_volume AS
SELECT
  s.id                            AS silo_id,
  s.kode,
  s.silo_name,
  s.is_buffer,
  s.kapasitas_maks_ltr,
  CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END AS toleransi_ltr,
  s.kapasitas_maks_ltr
    + CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END
                                   AS kapasitas_dengan_toleransi_ltr,
  s.standing_time_anchor,
  s.monitoring_interval_jam,
  s.urutan,
  COALESCE(v.vol_aktual_ltr, 0)   AS vol_aktual_ltr,
  COALESCE(v.jumlah_batch, 0)     AS jumlah_batch_aktif,
  COALESCE(v.vol_tak_dikenal_ltr, 0) AS vol_tak_dikenal_ltr,
  CASE WHEN COALESCE(v.vol_aktual_ltr, 0) > 0
       THEN ROUND(COALESCE(v.vol_tak_dikenal_ltr, 0) / v.vol_aktual_ltr * 100, 0)
       ELSE 0 END                 AS persen_tak_dikenal,
  GREATEST(s.kapasitas_maks_ltr - COALESCE(v.vol_aktual_ltr, 0), 0) AS vol_tersedia_ltr,
  GREATEST(
    s.kapasitas_maks_ltr
      + CASE WHEN s.toleransi_aktif THEN s.toleransi_ltr ELSE 0 END
      - COALESCE(v.vol_aktual_ltr, 0),
    0
  )                               AS vol_tersedia_toleransi_ltr,
  CASE WHEN s.kapasitas_maks_ltr > 0
       THEN ROUND(COALESCE(v.vol_aktual_ltr, 0) / s.kapasitas_maks_ltr * 100, 0)
       ELSE 0 END                 AS persen_isi,
  COALESCE(v.vol_aktual_ltr, 0) > s.kapasitas_maks_ltr AS dalam_toleransi
FROM silo s
LEFT JOIN (
  SELECT silo_id AS sid, SUM(qty_remaining_ltr) AS vol_aktual_ltr,
         COUNT(*) AS jumlah_batch, 0 AS vol_tak_dikenal_ltr
  FROM receiving
  WHERE status_fifo = 'ACTIVE'
    AND qty_remaining_ltr > 0
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_id
  UNION ALL
  SELECT silo_tujuan_id, SUM(qty_remaining_ltr), COUNT(*),
         SUM(CASE WHEN supplier_id IS NULL THEN qty_remaining_ltr ELSE 0 END)
  FROM prepast_record
  WHERE status_fifo = 'ACTIVE'
    AND qty_remaining_ltr > 0
    AND status_approval NOT IN ('Rejected','REVISED','VOIDED')
  GROUP BY silo_tujuan_id
) v ON v.sid = s.id
WHERE s.is_active = TRUE;

-- ---- Pengaturan aplikasi — baris tunggal, id selalu 1 ----
CREATE TABLE pengaturan_aplikasi (
  id                  TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  tampilkan_sisa_silo BOOLEAN NOT NULL DEFAULT TRUE
    COMMENT 'Tampilkan teks "sisa X L" pada dropdown pilih silo Prepast',
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                        ON UPDATE CURRENT_TIMESTAMP,
  updated_by_id       BIGINT NULL,
  CONSTRAINT ck_pengaturan_baris_tunggal CHECK (id = 1),
  CONSTRAINT fk_pengaturan_updated_by FOREIGN KEY (updated_by_id)
    REFERENCES operator (id)
) ENGINE=InnoDB;

INSERT INTO pengaturan_aplikasi (id, tampilkan_sisa_silo) VALUES (1, TRUE);

GRANT SELECT, INSERT, UPDATE, DELETE ON `fm_receiving`.`pengaturan_aplikasi` TO 'fm_app'@'%';
